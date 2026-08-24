import { Injectable, Inject, BadRequestException } from '@nestjs/common';
import pgLib from 'pg';
import type { Pool, PoolClient } from 'pg';
import type { OrderStatus } from '@razorveda/shared';
import { withRlsContext, type RlsSession } from '../db/rls-context.js';
import {
  assertTransition,
  dateFieldFor,
  IllegalTransitionError,
  ledgerEffectOf,
  repMayInitiate,
  type LedgerEffect,
} from './status-machine.js';

/**
 * Applying an order status change (Phase 3 deliverable 2).
 *
 * `status-machine.ts` was written in Phase 1 with its transition graph, its
 * clawback rule and twenty tests — and nothing ever called it. The fourth module
 * in this codebase to be certified and dead. Until now the only thing that ever
 * wrote to `order_status_event` was ORDER_ENTRY, stamping the opening PENDING,
 * so no order could ever reach DELIVERED and no credit could ever realise.
 *
 * This is the doorway. Every status change in the system goes through here, which
 * is what makes the guard worth having: a rule enforced in one place is enforced.
 *
 * THE MONEY RULE (CLAUDE.md rule 3, docs/03 §4):
 *
 *   Credit is earned on DELIVERY, not on booking. Booking writes a provisional
 *   BOOKED_CREDIT; delivery writes REALISED_CREDIT; a delivered order that comes
 *   back writes a CLAWBACK that reverses it exactly.
 *
 * Nothing here computes a money figure. The values are copied from the order's
 * existing BOOKED_CREDIT row, which `computeAttribution` produced at booking. Re-
 * deriving them at delivery would create a second source of truth for a number
 * that has already been agreed, and the two would drift the first time a base
 * price was corrected — the rep would be paid on one figure and shown another.
 */

export interface TransitionResult {
  readonly ok: true;
  readonly orderId: string;
  readonly from: OrderStatus;
  readonly to: OrderStatus;
  readonly ledgerEffect: LedgerEffect;
  /** Signed credit written by this transition, '0.00' when there was none. */
  readonly creditWritten: string;
  /** When this customer is due to reorder, set on delivery. Null if unknowable. */
  readonly repeatDueOn: string | null;
}

@Injectable()
export class StatusService {
  constructor(@Inject(pgLib.Pool) private readonly pool: Pool) {}

  async apply(
    session: RlsSession,
    orderId: string,
    to: OrderStatus,
    options: { readonly source: string } = { source: 'MANUAL' },
  ): Promise<TransitionResult> {
    return withRlsContext(this.pool, session, async (client) => {
      // FOR UPDATE, so two couriers reporting the same parcel at the same moment
      // cannot both read PENDING and both write a realisation. The ledger is
      // append-only: a duplicate credit cannot be deleted afterwards, only
      // adjusted, so the lock is cheaper than the correction.
      const { rows: [order] } = await client.query<{
        order_id: string;
        current_status: OrderStatus;
        booked_by_employee_id: string | null;
      }>(
        `SELECT order_id, current_status, booked_by_employee_id
           FROM "order" WHERE order_id = $1 FOR UPDATE`,
        [orderId],
      );

      // RLS returns nothing for another rep's order — same shape as lead detail,
      // and deliberately indistinguishable from "no such order".
      if (!order) throw new BadRequestException('That order was not found.');

      const from = order.current_status;

      // AUTHORITY, checked before legality. RLS already proved the order is hers;
      // this asks whether she may do this TO HER OWN ORDER. She could previously
      // walk one to DELIVERED in six requests and realise her own credit — no
      // admin, no courier, no parcel. Rule 3 says credit is earned on delivery,
      // and delivery was self-service.
      if (session.role === 'EMPLOYEE' && !repMayInitiate(from, to)) {
        throw new BadRequestException(
          `Only an admin can move an order to ${to.toLowerCase().replace(/_/g, ' ')}. ` +
            `Dispatch and delivery are recorded from the courier's updates, not by the person ` +
            `credited for the sale. You can confirm an order with the customer, or cancel it.`,
        );
      }

      try {
        assertTransition(from, to);
      } catch (e) {
        if (e instanceof IllegalTransitionError) {
          // Says what happened and what to do next, per the definition of done.
          throw new BadRequestException(
            `This order is ${from.toLowerCase().replace(/_/g, ' ')}, so it cannot move to ` +
              `${to.toLowerCase().replace(/_/g, ' ')}. Check the courier update — if the ` +
              `parcel really is at that stage, record the step it missed first.`,
          );
        }
        throw e;
      }

      // changed_by is the signed-in user, not the credited employee: who moved
      // the parcel and who earns on it are different questions, and conflating
      // them is how an audit trail stops being able to answer either.
      await client.query(
        `INSERT INTO order_status_event (order_id, from_status, to_status, source, changed_by)
         VALUES ($1,$2::order_status,$3::order_status,$4,$5)`,
        [orderId, from, to, options.source, session.userId],
      );

      // The date column is derived from the transition, never passed in — a
      // delivered_date that disagrees with the DELIVERED event would put an order
      // in one month for the report and another for the incentive.
      const dateField = dateFieldFor(to);
      await client.query(
        `UPDATE "order"
            SET current_status = $2::order_status,
                ${dateField ? `${dateField} = coalesce(${dateField}, CURRENT_DATE),` : ''}
                updated_at = now()
          WHERE order_id = $1`,
        [orderId, to],
      );

      const effect = ledgerEffectOf(from, to);
      const creditWritten = await this.writeLedger(client, orderId, order.booked_by_employee_id, effect);

      // Delivery is also what arms the repeat-purchase engine (deliverable 5).
      let repeatDueOn: string | null = null;
      if (to === 'DELIVERED') repeatDueOn = await this.scheduleRepeat(client, orderId);

      return { ok: true, orderId, from, to, ledgerEffect: effect, creditWritten, repeatDueOn };
    });
  }

  /**
   * Realisation and clawback, both copied from the order's BOOKED_CREDIT.
   *
   * An order with no BOOKED_CREDIT row realises nothing. That is not an error: it
   * is the `creditKnown: false` case from Order Entry (D-124), where a base price
   * was unconfirmed and the sale was recorded without a credit. Delivering it must
   * not invent a figure — the credit follows once an admin confirms the price.
   */
  private async writeLedger(
    client: PoolClient,
    orderId: string,
    bookedBy: string | null,
    effect: LedgerEffect,
  ): Promise<string> {
    if (effect === 'NONE') return '0.00';

    const { rows: [booked] } = await client.query<{
      employee_id: string;
      company_base_value: string;
      employee_credited_value: string;
      rule_applied: string;
      rule_version: number;
    }>(
      `SELECT employee_id, company_base_value::text, employee_credited_value::text,
              rule_applied, rule_version
         FROM attribution_ledger
        WHERE order_id = $1 AND entry_type = 'BOOKED_CREDIT'
        ORDER BY created_at LIMIT 1`,
      [orderId],
    );

    if (!booked) return '0.00';

    // A clawback is the exact negation of what was realised, so the two sum to
    // zero for that order. Recomputing the reversal instead of negating would let
    // it disagree with the credit it is meant to cancel.
    const sign = effect === 'CLAWBACK' ? -1 : 1;
    const credited = signed(booked.employee_credited_value, sign);
    const base = signed(booked.company_base_value, sign);

    // A clawback belongs to the period it HAPPENS in, not the one that earned the
    // credit. Incentive is cash basis (metric dictionary §6): reopening a closed
    // month to reverse a payment already made would make a March report change in
    // December, which is the whole thing this ledger exists to prevent.
    await client.query(
      `INSERT INTO attribution_ledger (order_id, employee_id, entry_type, company_base_value,
                                       employee_credited_value, rule_applied, rule_version,
                                       is_realised, period_key)
       VALUES ($1,$2,$3::ledger_entry_type,$4,$5,$6,$7,true,
               to_char(CURRENT_DATE,'YYYY-MM'))`,
      [
        orderId,
        // The employee credited at booking, not whoever is signed in now. A rep
        // must not gain or lose credit because someone else marked the parcel.
        booked.employee_id ?? bookedBy,
        effect,
        base,
        credited,
        booked.rule_applied,
        booked.rule_version,
      ],
    );

    return credited;
  }

  /**
   * The repeat-purchase engine's first half (deliverable 5, docs/02).
   *
   *   next_due_date = delivered_date + sku.usage_days - 5
   *
   * The five days are the point: call BEFORE she runs out, not after, because a
   * customer who has already finished the jar has had a week to buy elsewhere.
   *
   * MIN across the order's lines, not MAX. If she buys a 30-day cream and a
   * 60-day supplement, the first thing to run out is what creates the reorder
   * conversation — waiting for the longest-lasting item means missing the cream
   * entirely. She can be sold both on that call.
   *
   * `usage_days` is NULL for SKUs the client has not characterised (O-03), and a
   * NULL must NOT become a guess. No due date is set, and the customer simply does
   * not enter the repeat queue — a missed opportunity, which is recoverable, rather
   * than a rep calling at a fabricated moment, which costs credibility.
   */
  private async scheduleRepeat(client: PoolClient, orderId: string): Promise<string | null> {
    const { rows: [due] } = await client.query<{ next_due_date: string | null }>(
      `WITH shortest AS (
         SELECT o.customer_id, o.delivered_date, min(s.usage_days) AS usage_days,
                -- Is the SHORTEST SKU's figure confirmed? Evaluated over the rows
                -- that tie at the minimum, because that is the SKU the date is
                -- computed from. An unconfirmed SKU that runs out much later has
                -- no bearing on whether THIS date is an estimate.
                bool_and(s.usage_days_confirmed) FILTER (
                  WHERE s.usage_days = (
                    SELECT min(s2.usage_days)
                      FROM order_line ol2 JOIN sku s2 ON s2.sku_id = ol2.sku_id
                     WHERE ol2.order_id = o.order_id AND s2.usage_days IS NOT NULL
                  )
                ) AS driver_confirmed
           FROM "order" o
           JOIN order_line ol ON ol.order_id = o.order_id
           JOIN sku s ON s.sku_id = ol.sku_id
          WHERE o.order_id = $1 AND s.usage_days IS NOT NULL
          GROUP BY o.customer_id, o.delivered_date
       )
       UPDATE customer c
          SET next_due_date = (shortest.delivered_date + shortest.usage_days - 5),
              -- NULL reads as UNCONFIRMED: a null here means the FILTER matched
              -- nothing, and an unknown provenance must present as an estimate
              -- rather than as a promise.
              next_due_date_provisional = NOT coalesce(shortest.driver_confirmed, false),
              -- The rep who delivered it owns the reorder. Without an owner the
              -- lead would land in the unassigned pool and the relationship that
              -- earned the repeat would be handed to a stranger.
              owner_employee_id = coalesce(
                (SELECT booked_by_employee_id FROM "order" WHERE order_id = $1),
                c.owner_employee_id
              ),
              updated_at = now()
         FROM shortest
        WHERE c.customer_id = shortest.customer_id
    RETURNING c.next_due_date::text`,
      [orderId],
    );
    return due?.next_due_date ?? null;
  }
}

/** Exact string negation — no float ever touches a money value. */
function signed(value: string, sign: 1 | -1): string {
  if (sign === 1) return value;
  return value.startsWith('-') ? value.slice(1) : `-${value}`;
}
