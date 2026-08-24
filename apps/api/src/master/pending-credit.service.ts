import { Inject, Injectable } from '@nestjs/common';
import pgLib from 'pg';
import type { Pool, PoolClient } from 'pg';
import { withRlsContext, type RlsSession } from '../db/rls-context.js';
import {
  AttributionError,
  computeAttribution,
  type AttributionLine,
  type AttributionRule,
} from '../orders/attribution.js';

/**
 * COMPLETING THE CREDIT THAT WAS PROMISED AND NEVER ARRIVED.
 *
 * D-124: when a base price is unconfirmed, the order still books, no ledger row
 * is written, and the rep is told - in these words - "Book the order, an admin
 * will confirm the price and your credit will follow."
 *
 * Nothing made it follow. `confirmBasePrice` says so explicitly: it does not
 * retro-credit, and "completing them is a separate, deliberate act". That act was
 * never built. So every order booked against an unconfirmed price has been sitting
 * with no credit, and the rep who made the sale has no way to see why - the same
 * shape of defect as the scheduler: a promise written in a comment.
 *
 * This is that act. It recomputes with the SAME `computeAttribution` the booking
 * path uses, because a second implementation of a money rule is how two answers
 * to "what is she owed" come to exist.
 *
 * FAITHFUL, NOT REBUILT. Every input the booking path had is still stored:
 * `order_line.is_upsell`, `order_credit_split`, and the rule and credit percent on
 * `lead_source`. Nothing here is inferred, so the figure it produces is the figure
 * booking would have produced had the price been confirmed at the time.
 */

/** An order carrying no ledger entry at all. */
export interface PendingOrder {
  readonly orderId: string;
  readonly orderNumber: string;
  readonly status: string;
  readonly finalValue: string;
  readonly repName: string | null;
  /** Null once it can be computed; otherwise why it still cannot be. */
  readonly blockedBy: string | null;
}

export interface CompleteResult {
  readonly completed: number;
  readonly stillBlocked: number;
  readonly needsDecision: number;
  readonly creditWritten: string;
  readonly orders: readonly PendingOrder[];
}

interface CandidateRow {
  order_id: string;
  order_number: string;
  current_status: string;
  final_value: string;
  attribution: string;
  employee_credit_percent: string;
  rep_name: string | null;
}

interface LineRow {
  order_id: string;
  sku_code: string;
  quantity: number;
  shopify_base_price: string | null;
  shopify_base_price_confirmed: boolean;
  is_upsell: boolean;
}

/**
 * Statuses where writing BOOKED_CREDIT now would be arriving too late to matter.
 *
 * Credit realises on DELIVERY (rule 3), and `status.service` writes REALISED_CREDIT
 * by copying the BOOKED_CREDIT row that existed at the time. An order that was
 * already delivered while its credit was pending therefore got neither - and
 * writing only BOOKED_CREDIT now would leave it provisional forever.
 *
 * Realising it retroactively is NOT done here, deliberately. The realised entry
 * would carry a period_key, and dating it to the delivery month changes a month
 * that may already have been reported and paid - which is precisely what
 * append-only exists to prevent. Dating it to the current month is defensible on a
 * cash basis but is a payroll decision, not an engineering one.
 *
 * So these are COUNTED AND NAMED rather than quietly handled. An admin can see
 * exactly which orders and how much, and decide.
 */
const ALREADY_SETTLED = ['DELIVERED', 'RTO', 'RETURNED'];

@Injectable()
export class PendingCreditService {
  constructor(@Inject(pgLib.Pool) private readonly pool: Pool) {}

  /**
   * What is waiting, and why. Read-only.
   *
   * CAPPED, AND THE COUNT IS STILL TRUE.
   *
   * The first version evaluated every candidate and returned all of them. On the
   * client's volume that is 26,869 orders — each one run through
   * `computeAttribution` — sent down the wire so a screen could draw one number.
   * The admin home page waited on it and rendered without that card entirely.
   *
   * Exactly the shape of D-231, where a rep received all 14,381 of her leads
   * because nothing capped the page.
   *
   * So `waiting` is an exact SQL count — cheap, and no attribution needed to know
   * an order has no ledger row — while the detailed, expensive evaluation runs
   * only over the page actually being shown. The count is never the length of
   * what was returned.
   */
  async summary(session: RlsSession): Promise<{ waiting: number }> {
    return withRlsContext(this.pool, session, async (client) => {
      const { rows: [row] } = await client.query<{ n: string }>(
        `SELECT count(*)::text AS n
           FROM "order" o
          WHERE o.ingestion_batch_id IS NULL
            AND o.booked_by_employee_id IS NOT NULL
            AND NOT EXISTS (SELECT 1 FROM attribution_ledger l WHERE l.order_id = o.order_id)`,
      );
      return { waiting: Number(row?.n ?? '0') };
    });
  }

  async list(session: RlsSession, limit = 100): Promise<readonly PendingOrder[]> {
    return withRlsContext(this.pool, session, async (client) => this.evaluate(client, limit));
  }

  /**
   * Writes the credit for every order that can now be computed.
   *
   * Idempotent by construction: the candidate query only returns orders with NO
   * ledger row, so a second run finds nothing. That matters because this is
   * called straight after a price upload, and an admin who clicks twice must not
   * pay anyone twice.
   */
  async complete(session: RlsSession): Promise<CompleteResult> {
    return withRlsContext(this.pool, session, async (client) => {
      // No limit here, deliberately. Capping the page an admin READS is a
      // transport decision; capping what gets PAID would quietly credit the first
      // hundred orders and report success.
      const evaluated = await this.evaluate(client);

      let completed = 0;
      let credit = 0;

      for (const order of evaluated) {
        if (order.blockedBy !== null) continue;
        if (ALREADY_SETTLED.includes(order.status)) continue;

        const written = await this.writeCredit(client, session, order.orderId);
        if (written !== null) {
          completed += 1;
          credit += Number(written);
        }
      }

      return {
        completed,
        stillBlocked: evaluated.filter((o) => o.blockedBy !== null).length,
        needsDecision: evaluated.filter(
          (o) => o.blockedBy === null && ALREADY_SETTLED.includes(o.status),
        ).length,
        creditWritten: credit.toFixed(2),
        orders: evaluated,
      };
    });
  }

  /**
   * The candidate set, with attribution attempted for each.
   *
   * THE GUARD THAT MATTERS: `ingestion_batch_id IS NULL`.
   *
   * Historically imported orders carry no ledger rows BY DESIGN (D-178) - the
   * backfill exists to reconstruct history, not to pay anyone for it. Without this
   * clause "complete pending credit" would retroactively credit the client's
   * entire import, which at 180,000 orders is not a bug anyone recovers from
   * quietly.
   */
  private async evaluate(client: PoolClient, limit?: number): Promise<readonly PendingOrder[]> {
    const { rows: candidates } = await client.query<CandidateRow>(
      `SELECT o.order_id, o.order_number, o.current_status, o.final_value::text,
              s.attribution, s.employee_credit_percent::text, e.full_name AS rep_name
         FROM "order" o
         JOIN lead_source s ON s.source_id = o.source_id
         LEFT JOIN employee e ON e.employee_id = o.booked_by_employee_id
        WHERE o.ingestion_batch_id IS NULL
          AND o.booked_by_employee_id IS NOT NULL
          AND NOT EXISTS (
            SELECT 1 FROM attribution_ledger l WHERE l.order_id = o.order_id
          )
        ORDER BY o.order_date, o.order_number
        ${limit !== undefined ? 'LIMIT ' + Number(limit) : ''}`,
    );
    if (candidates.length === 0) return [];

    const { rows: lines } = await client.query<LineRow>(
      `SELECT ol.order_id, k.sku_code, ol.quantity,
              k.shopify_base_price::text, k.shopify_base_price_confirmed, ol.is_upsell
         FROM order_line ol
         JOIN sku k ON k.sku_id = ol.sku_id
        WHERE ol.order_id = ANY($1::uuid[])`,
      [candidates.map((c) => c.order_id)],
    );

    const byOrder = new Map<string, LineRow[]>();
    for (const l of lines) byOrder.set(l.order_id, [...(byOrder.get(l.order_id) ?? []), l]);

    return candidates.map((c) => {
      const base = {
        orderId: c.order_id,
        orderNumber: c.order_number,
        status: c.current_status,
        finalValue: c.final_value,
        repName: c.rep_name,
      };

      const attempt = this.attempt(c, byOrder.get(c.order_id) ?? []);
      return { ...base, blockedBy: attempt };
    });
  }

  /** Null when attribution succeeds; otherwise the reason, in words an admin can act on. */
  private attempt(order: CandidateRow, lines: readonly LineRow[]): string | null {
    if (lines.length === 0) {
      return 'This order has no product lines, so there is nothing to attribute.';
    }
    try {
      computeAttribution({
        rule: order.attribution as AttributionRule,
        employeeCreditPercent: order.employee_credit_percent,
        finalValue: order.final_value,
        lines: lines.map(
          (l): AttributionLine => ({
            skuId: l.sku_code,
            quantity: l.quantity,
            shopifyBasePrice: l.shopify_base_price,
            shopifyBasePriceConfirmed: l.shopify_base_price_confirmed,
            isUpsell: l.is_upsell,
          }),
        ),
      });
      return null;
    } catch (e) {
      if (e instanceof AttributionError) return e.message;
      throw e;
    }
  }

  /**
   * Writes one BOOKED_CREDIT row. Returns the credited value, or null.
   *
   * Recomputed inside the same transaction rather than trusting the value from
   * `evaluate`, so a price changed between the preview and the click cannot write
   * a figure the admin never saw was stale.
   */
  private async writeCredit(
    client: PoolClient,
    session: RlsSession,
    orderId: string,
  ): Promise<string | null> {
    const { rows: [order] } = await client.query<CandidateRow>(
      `SELECT o.order_id, o.order_number, o.current_status, o.final_value::text,
              s.attribution, s.employee_credit_percent::text, NULL AS rep_name
         FROM "order" o JOIN lead_source s ON s.source_id = o.source_id
        WHERE o.order_id = $1`,
      [orderId],
    );
    if (!order) return null;

    const { rows: lines } = await client.query<LineRow>(
      `SELECT ol.order_id, k.sku_code, ol.quantity, k.shopify_base_price::text,
              k.shopify_base_price_confirmed, ol.is_upsell
         FROM order_line ol JOIN sku k ON k.sku_id = ol.sku_id
        WHERE ol.order_id = $1`,
      [orderId],
    );

    let result;
    try {
      result = computeAttribution({
        rule: order.attribution as AttributionRule,
        employeeCreditPercent: order.employee_credit_percent,
        finalValue: order.final_value,
        lines: lines.map(
          (l): AttributionLine => ({
            skuId: l.sku_code,
            quantity: l.quantity,
            shopifyBasePrice: l.shopify_base_price,
            shopifyBasePriceConfirmed: l.shopify_base_price_confirmed,
            isUpsell: l.is_upsell,
          }),
        ),
      });
    } catch (e) {
      // Became blocked again between preview and commit. Not an error worth
      // failing the whole run for - the other orders are still completable.
      if (e instanceof AttributionError) return null;
      throw e;
    }

    // period_key is the CURRENT month, not the order's.
    //
    // The credit becomes knowable now. Dating it to the month the order was
    // booked would change a period that may already have been reported, and
    // "a March report reproducible in December" is the guarantee append-only
    // exists to provide. This entry is provisional anyway - BOOKED_CREDIT pays
    // nobody until the order is delivered (rule 3).
    //
    // `company_base_value` is also written onto the order, which was left at its
    // 0 default when the credit was skipped. The order and the ledger must agree.
    await client.query(
      `INSERT INTO attribution_ledger (order_id, employee_id, entry_type, company_base_value,
                                       employee_credited_value, rule_applied, period_key,
                                       is_realised, note)
       SELECT $1, o.booked_by_employee_id, 'BOOKED_CREDIT', $2, $3, $4,
              to_char(CURRENT_DATE,'YYYY-MM'), false,
              'Credit completed after the base price was confirmed. Booked ' ||
              to_char(o.order_date,'DD Mon YYYY') || ' with the price still unconfirmed (D-124).'
         FROM "order" o WHERE o.order_id = $1`,
      [orderId, result.companyBaseValue, result.employeeCreditedValue, result.ruleApplied],
    );

    await client.query(`UPDATE "order" SET company_base_value = $2 WHERE order_id = $1`, [
      orderId,
      result.companyBaseValue,
    ]);

    await client.query(
      `INSERT INTO audit_log (actor_id, actor_role, action, entity_type, entity_id, after_json)
       VALUES ($1,$2::user_role,'PENDING_CREDIT_COMPLETED','order',$3,$4::jsonb)`,
      [
        session.userId,
        session.role,
        orderId,
        JSON.stringify({
          order_number: order.order_number,
          company_base_value: result.companyBaseValue,
          employee_credited_value: result.employeeCreditedValue,
          rule_applied: result.ruleApplied,
        }),
      ],
    );

    return result.employeeCreditedValue;
  }
}
