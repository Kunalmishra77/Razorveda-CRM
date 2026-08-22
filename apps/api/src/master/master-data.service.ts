import { Injectable, Inject, BadRequestException } from '@nestjs/common';
import pgLib from 'pg';
import type { Pool, PoolClient } from 'pg';
import { withRlsContext, type RlsSession } from '../db/rls-context.js';

/**
 * Master Data (docs/07 §6) — the screens an admin uses to configure the system.
 *
 * Until now none of this existed as an endpoint, which had two live consequences:
 *
 *   1. Twenty active SKUs have no confirmed Shopify base price. Orders on them
 *      book normally and the rep earns NOTHING until a price is confirmed
 *      (D-124), and there was no way to confirm one short of raw SQL. The
 *      exception digest has been reporting this every morning with no route to
 *      fixing it.
 *   2. The incentive scheme is the proposals from docs/03 §6, not the client's,
 *      and every payable figure is stamped "not approvable for payment" (O-09).
 *      Answering that question required someone to send me numbers. It should
 *      require an admin to type them in.
 *
 * VERSIONING IS THE DESIGN, NOT A FEATURE.
 *
 * docs/03 §6: "all slabs and modifiers live in tables, versioned, admin-editable."
 * So changing a slab CLOSES the old row and opens a new one with an effective
 * date. It never edits the values in place. That is what lets March be recomputed
 * in December and return March's answer — the same reasoning that makes the
 * attribution ledger append-only.
 */

export interface ConfirmPriceInput {
  readonly skuId: string;
  readonly basePrice: string;
}

@Injectable()
export class MasterDataService {
  constructor(@Inject(pgLib.Pool) private readonly pool: Pool) {}

  // ── SKUs and base prices ───────────────────────────────────────────────────

  async skus(session: RlsSession) {
    return this.write(session, async (client) => {
      const { rows } = await client.query(
        `SELECT s.sku_id, s.sku_code, s.product_name, p.name AS product_line,
                s.mrp::text, s.shopify_base_price::text, s.shopify_base_price_confirmed,
                s.shopify_base_price_set_at, s.usage_days, s.is_active,
                u.email AS confirmed_by
           FROM sku s
           JOIN product_line p ON p.line_id = s.line_id
           LEFT JOIN app_user u ON u.user_id = s.shopify_base_price_set_by
          WHERE s.is_active
          ORDER BY s.shopify_base_price_confirmed, p.name, s.product_name`,
      );
      return rows;
    });
  }

  /**
   * Confirm a SKU's Shopify base price.
   *
   * This is a MONEY action: `company_base_value` is looked up from it and
   * `employee_credited_value` is `final_value − company_base_value`. Confirming
   * the wrong number silently changes what every rep earns on that product, so it
   * records who confirmed it and when, and writes an audit row carrying the
   * previous value.
   *
   * It does NOT retro-credit past orders. Orders booked while the price was
   * unconfirmed have no ledger entry (D-124); completing them is a separate,
   * deliberate act, not a side effect of typing a number into a form.
   */
  async confirmBasePrice(session: RlsSession, input: ConfirmPriceInput) {
    if (!/^\d{1,8}(\.\d{1,2})?$/.test(input.basePrice)) {
      throw new BadRequestException('The base price must be a number, like 500 or 499.50.');
    }

    return this.write(session, async (client) => {
      const { rows: [before] } = await client.query<{
        sku_code: string; product_name: string; mrp: string;
        shopify_base_price: string | null; shopify_base_price_confirmed: boolean;
      }>(
        `SELECT sku_code, product_name, mrp::text, shopify_base_price::text,
                shopify_base_price_confirmed
           FROM sku WHERE sku_id = $1`,
        [input.skuId],
      );
      if (!before) throw new BadRequestException('That product was not found.');

      // A base price above MRP means the company committed more than the customer
      // pays, so the rep's credit would be negative. Refused rather than clamped:
      // it is a typo, and clamping would hide it.
      if (Number(input.basePrice) > Number(before.mrp)) {
        throw new BadRequestException(
          `A base price of ₹${input.basePrice} is more than the ₹${before.mrp} MRP for ` +
            `${before.product_name}. The rep's credit would be negative. Check the figure.`,
        );
      }

      await client.query(
        `UPDATE sku
            SET shopify_base_price = $2,
                shopify_base_price_confirmed = true,
                shopify_base_price_set_by = $3,
                shopify_base_price_set_at = now()
          WHERE sku_id = $1`,
        [input.skuId, input.basePrice, session.userId],
      );

      await client.query(
        `INSERT INTO audit_log (actor_id, actor_role, action, entity_type, entity_id,
                                before_json, after_json)
         VALUES ($1,$2::user_role,'SKU_BASE_PRICE_CONFIRMED','sku',$3,$4::jsonb,$5::jsonb)`,
        [
          session.userId, session.role, input.skuId,
          JSON.stringify({
            base_price: before.shopify_base_price,
            confirmed: before.shopify_base_price_confirmed,
          }),
          JSON.stringify({ base_price: input.basePrice, confirmed: true }),
        ],
      );

      const { rows: [pending] } = await client.query<{ n: string }>(
        `SELECT count(*)::text AS n FROM sku WHERE is_active AND NOT shopify_base_price_confirmed`,
      );

      return {
        skuCode: before.sku_code,
        productName: before.product_name,
        basePrice: input.basePrice,
        creditOnAnMrpSale: (Number(before.mrp) - Number(input.basePrice)).toFixed(2),
        stillUnconfirmed: Number(pending?.n ?? '0'),
      };
    });
  }

  /** `usage_days` drives the repeat engine (O-03). NULL means the SKU never queues. */
  async setUsageDays(session: RlsSession, skuId: string, usageDays: number | null) {
    if (usageDays !== null && (!Number.isInteger(usageDays) || usageDays < 1 || usageDays > 365)) {
      throw new BadRequestException('Usage days must be a whole number between 1 and 365, or blank.');
    }
    return this.write(session, async (client) => {
      const { rowCount } = await client.query(`UPDATE sku SET usage_days = $2 WHERE sku_id = $1`, [
        skuId, usageDays,
      ]);
      if (!rowCount) throw new BadRequestException('That product was not found.');
      await client.query(
        `INSERT INTO audit_log (actor_id, actor_role, action, entity_type, entity_id, after_json)
         VALUES ($1,$2::user_role,'SKU_USAGE_DAYS_SET','sku',$3,$4::jsonb)`,
        [session.userId, session.role, skuId, JSON.stringify({ usage_days: usageDays })],
      );
      return { ok: true };
    });
  }

  // ── the incentive scheme ───────────────────────────────────────────────────

  async incentiveScheme(session: RlsSession) {
    return this.write(session, async (client) => {
      const { rows: slabs } = await client.query(
        `SELECT slab_id, min_value::text, max_value::text, percent::text,
                effective_from, effective_to, is_provisional
           FROM incentive_slab
          WHERE effective_to IS NULL
          ORDER BY min_value`,
      );
      const { rows: modifiers } = await client.query(
        `SELECT m.modifier_id, m.kind::text, m.threshold_min::text, m.threshold_max::text,
                m.value::text, m.effective_from, m.is_provisional, m.note, p.name AS product_line
           FROM incentive_modifier m
           LEFT JOIN product_line p ON p.line_id = m.line_id
          WHERE m.effective_to IS NULL
          ORDER BY m.kind, m.threshold_min`,
      );

      const provisional =
        slabs.some((s) => s.is_provisional) || modifiers.some((m) => m.is_provisional);

      return {
        slabs,
        modifiers,
        provisional,
        ...(provisional
          ? {
              warning:
                'These are the PROPOSALS from docs/03 §6, not a confirmed scheme (O-09). Every ' +
                'incentive figure in the month-close pack is stamped "not approvable for payment" ' +
                'until someone replaces them with the real ones and marks them confirmed.',
            }
          : {}),
      };
    });
  }

  /**
   * Replace the slab table with a confirmed scheme, effective from a date.
   *
   * SUPERSEDES rather than edits. The existing rows are closed the day before the
   * new scheme starts, and the new rows are inserted — so recomputing a past month
   * still finds the slabs that were in force then. Editing the percentages in
   * place would silently rewrite every incentive statement ever produced.
   */
  async replaceSlabs(
    session: RlsSession,
    effectiveFrom: string,
    slabs: ReadonlyArray<{ minValue: string; maxValue: string | null; percent: string }>,
    confirmed: boolean,
  ) {
    if (slabs.length === 0) throw new BadRequestException('Give at least one slab.');

    // The bands must cover the range without a hole. A gap makes computeIncentive
    // refuse (D-153), which is right at calculation time and much better caught
    // here, while someone is looking at the numbers.
    const sorted = [...slabs].sort((a, b) => Number(a.minValue) - Number(b.minValue));
    for (let i = 0; i < sorted.length - 1; i += 1) {
      const upper = sorted[i]!.maxValue;
      if (upper === null) {
        throw new BadRequestException('Only the highest slab may have an open top end.');
      }
      if (Number(upper) !== Number(sorted[i + 1]!.minValue)) {
        throw new BadRequestException(
          `There is a gap between ₹${upper} and ₹${sorted[i + 1]!.minValue}. A rep landing in ` +
            `it would have no slab at all, and her statement would refuse to calculate.`,
        );
      }
    }
    if (Number(sorted[0]!.minValue) !== 0) {
      throw new BadRequestException(
        `The lowest slab must start at 0, or a rep below ₹${sorted[0]!.minValue} has no slab. ` +
          `Use 0% if nothing is payable at that level.`,
      );
    }

    return this.write(session, async (client) => {
      await client.query(
        `UPDATE incentive_slab SET effective_to = ($1::date - 1)
          WHERE effective_to IS NULL AND effective_from < $1::date`,
        [effectiveFrom],
      );
      // Rows that would start on or after the new date are CLOSED TO AN EMPTY
      // WINDOW, not deleted. `app_role` has no DELETE on this table — the same
      // no-delete posture as everywhere else in the schema, and the right one:
      // that someone once entered a scheme is worth keeping even when it never
      // took effect. `effective_to` one day before `effective_from` is a window
      // no date can fall inside, which is exactly what "never in force" means.
      await client.query(
        `UPDATE incentive_slab SET effective_to = effective_from - 1
          WHERE effective_to IS NULL AND effective_from >= $1::date`,
        [effectiveFrom],
      );

      for (const slab of sorted) {
        await client.query(
          `INSERT INTO incentive_slab (min_value, max_value, percent, effective_from, is_provisional)
           VALUES ($1,$2,$3,$4::date,$5)`,
          [slab.minValue, slab.maxValue, slab.percent, effectiveFrom, !confirmed],
        );
      }

      await client.query(
        `INSERT INTO audit_log (actor_id, actor_role, action, entity_type, after_json)
         VALUES ($1,$2::user_role,'INCENTIVE_SLABS_REPLACED','incentive_slab',$3::jsonb)`,
        [session.userId, session.role, JSON.stringify({ effectiveFrom, confirmed, slabs: sorted })],
      );

      return { slabs: sorted.length, effectiveFrom, confirmed };
    });
  }

  /** Same versioning rule for a single modifier. */
  async replaceModifier(
    session: RlsSession,
    modifierId: string,
    value: string,
    effectiveFrom: string,
    confirmed: boolean,
  ) {
    return this.write(session, async (client) => {
      const { rows: [old] } = await client.query<{
        kind: string; threshold_min: string | null; threshold_max: string | null;
        line_id: string | null; note: string | null; value: string;
      }>(
        `SELECT kind::text, threshold_min::text, threshold_max::text, line_id, note, value::text
           FROM incentive_modifier WHERE modifier_id = $1`,
        [modifierId],
      );
      if (!old) throw new BadRequestException('That modifier was not found.');

      await client.query(
        `UPDATE incentive_modifier SET effective_to = ($2::date - 1) WHERE modifier_id = $1`,
        [modifierId, effectiveFrom],
      );
      await client.query(
        `INSERT INTO incentive_modifier (kind, threshold_min, threshold_max, line_id, value,
                                         effective_from, is_provisional, note)
         VALUES ($1::incentive_modifier_kind,$2,$3,$4,$5,$6::date,$7,$8)`,
        [old.kind, old.threshold_min, old.threshold_max, old.line_id, value,
         effectiveFrom, !confirmed, old.note],
      );

      await client.query(
        `INSERT INTO audit_log (actor_id, actor_role, action, entity_type, entity_id,
                                before_json, after_json)
         VALUES ($1,$2::user_role,'INCENTIVE_MODIFIER_REPLACED','incentive_modifier',$3,
                 $4::jsonb,$5::jsonb)`,
        [session.userId, session.role, modifierId,
         JSON.stringify({ value: old.value }),
         JSON.stringify({ value, effectiveFrom, confirmed })],
      );

      return { kind: old.kind, from: old.value, to: value, effectiveFrom };
    });
  }

  // ── the roster ─────────────────────────────────────────────────────────────

  async roster(session: RlsSession) {
    return this.write(session, async (client) => {
      const { rows } = await client.query(
        `SELECT e.employee_id, e.emp_code, e.full_name, e.status::text,
                e.monthly_target::text, u.email, u.role::text, u.is_locked,
                (SELECT count(*)::int FROM lead l
                  WHERE l.assigned_to = e.employee_id AND NOT l.is_converted
                    AND l.closed_at IS NULL) AS live_leads
           FROM employee e
           LEFT JOIN app_user u ON u.user_id = e.user_id
          ORDER BY e.status, e.emp_code`,
      );
      return rows;
    });
  }

  /**
   * Set a rep's monthly target.
   *
   * A target is what a person is measured against, so the change is audited with
   * the previous value. The RTO-adjusted required-booking figure is derived from
   * it (D-171), and that correction is still off pending a decision — so raising
   * a target here changes the delivery goal, not yet the booking one.
   */
  async setTarget(session: RlsSession, employeeId: string, monthlyTarget: string) {
    if (!/^\d{1,10}(\.\d{1,2})?$/.test(monthlyTarget)) {
      throw new BadRequestException('The target must be a number, like 300000.');
    }
    return this.write(session, async (client) => {
      const { rows: [before] } = await client.query<{ full_name: string; monthly_target: string }>(
        `SELECT full_name, monthly_target::text FROM employee WHERE employee_id = $1`,
        [employeeId],
      );
      if (!before) throw new BadRequestException('That employee was not found.');

      await client.query(`UPDATE employee SET monthly_target = $2, updated_at = now() WHERE employee_id = $1`, [
        employeeId, monthlyTarget,
      ]);
      await client.query(
        `INSERT INTO audit_log (actor_id, actor_role, action, entity_type, entity_id,
                                before_json, after_json)
         VALUES ($1,$2::user_role,'TARGET_CHANGED','employee',$3,$4::jsonb,$5::jsonb)`,
        [session.userId, session.role, employeeId,
         JSON.stringify({ monthly_target: before.monthly_target }),
         JSON.stringify({ monthly_target: monthlyTarget })],
      );
      return { employee: before.full_name, from: before.monthly_target, to: monthlyTarget };
    });
  }

  private async write<T>(session: RlsSession, fn: (c: PoolClient) => Promise<T>): Promise<T> {
    return withRlsContext(this.pool, session, fn);
  }
}
