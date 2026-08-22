import { Injectable, Inject } from '@nestjs/common';
import pgLib from 'pg';
import type { Pool, PoolClient } from 'pg';
import { withRlsContext, type RlsSession } from '../db/rls-context.js';
import { computeIncentive, type IncentiveBreakdown, type Modifier, type Slab } from './incentive.js';

/**
 * Reading the ledger and handing it to the incentive engine (docs/03 §6).
 *
 * The split is deliberate: this file gathers facts, `incentive.ts` decides. Every
 * branch of the money rule is therefore testable without a database, and the SQL
 * here contains no arithmetic anyone has to trust — it sums and counts, nothing
 * more.
 *
 * PERIOD BASIS IS CASH (metric dictionary §7, D-13).
 *
 * The period comes from `attribution_ledger.period_key`, which is stamped when the
 * entry is written — NOT from the order's date. An order booked in March and
 * delivered in April pays in April, and a March order returned in May reduces May.
 * Reading the order date instead would make a closed month's figure change after
 * it had been paid.
 */

export interface IncentiveStatement extends IncentiveBreakdown {
  readonly employeeId: string;
  readonly employeeName: string;
  readonly periodKey: string;
}

@Injectable()
export class IncentiveService {
  constructor(@Inject(pgLib.Pool) private readonly pool: Pool) {}

  async statement(
    session: RlsSession,
    employeeId: string,
    periodKey: string,
  ): Promise<IncentiveStatement> {
    return withRlsContext(this.pool, session, async (client) => {
      const [facts, slabs, modifiers] = await Promise.all([
        this.facts(client, employeeId, periodKey),
        this.slabs(client, periodKey),
        this.modifiers(client, periodKey),
      ]);

      const breakdown = computeIncentive({
        realisedCredited: facts.realisedCredited,
        ordersDelivered: facts.ordersDelivered,
        ordersRto: facts.ordersRto,
        prepaidRatio: facts.prepaidRatio,
        repeatOrders: facts.repeatOrders,
        lineIds: facts.lineIds,
        slabs,
        modifiers,
      });

      return {
        ...breakdown,
        employeeId,
        employeeName: facts.employeeName,
        periodKey,
      };
    });
  }

  private async facts(client: PoolClient, employeeId: string, periodKey: string) {
    const { rows: [row] } = await client.query<{
      employee_name: string;
      realised_credited: string;
      orders_delivered: string;
      orders_rto: string;
      prepaid_ratio: string;
      repeat_orders: string;
      line_ids: string[];
    }>(
      `WITH ledger AS (
         -- Realised entries only. BOOKED_CREDIT is provisional and rule 3 says
         -- nothing is ever paid on it; clawbacks are already negative, so the
         -- sum IS "realised minus clawback" without a second term (D-139).
         SELECT coalesce(sum(employee_credited_value), 0)::text AS realised_credited
           FROM attribution_ledger
          WHERE employee_id = $1 AND period_key = $2 AND is_realised
       ), shipped AS (
         -- Counted over orders that reached a terminal delivery outcome IN this
         -- period, which is what the RTO band is measured on (docs/03 §3).
         SELECT
           count(*) FILTER (WHERE o.current_status = 'DELIVERED')            AS delivered,
           count(*) FILTER (WHERE o.current_status IN ('RTO','RETURNED'))    AS rto,
           coalesce(sum(o.prepaid_amount) FILTER (WHERE o.current_status = 'DELIVERED'), 0) AS prepaid,
           coalesce(sum(o.final_value)   FILTER (WHERE o.current_status = 'DELIVERED'), 0) AS value,
           count(*) FILTER (WHERE o.current_status = 'DELIVERED' AND c.lifetime_orders >= 3) AS repeats
           FROM "order" o
           JOIN customer c ON c.customer_id = o.customer_id
          WHERE o.booked_by_employee_id = $1
            AND to_char(coalesce(o.delivered_date, o.rto_date), 'YYYY-MM') = $2
       ), lines AS (
         SELECT coalesce(array_agg(DISTINCT s.line_id), '{}') AS line_ids
           FROM "order" o
           JOIN order_line ol ON ol.order_id = o.order_id
           JOIN sku s ON s.sku_id = ol.sku_id
          WHERE o.booked_by_employee_id = $1
            AND o.current_status = 'DELIVERED'
            AND to_char(o.delivered_date, 'YYYY-MM') = $2
       )
       SELECT e.full_name AS employee_name,
              ledger.realised_credited,
              shipped.delivered::text AS orders_delivered,
              shipped.rto::text       AS orders_rto,
              CASE WHEN shipped.value > 0
                   THEN (shipped.prepaid / shipped.value)::numeric(10,4)::text
                   ELSE '0.0000' END  AS prepaid_ratio,
              shipped.repeats::text   AS repeat_orders,
              lines.line_ids
         FROM employee e, ledger, shipped, lines
        WHERE e.employee_id = $1`,
      [employeeId, periodKey],
    );

    return {
      employeeName: row?.employee_name ?? 'Unknown',
      realisedCredited: row?.realised_credited ?? '0.00',
      ordersDelivered: Number(row?.orders_delivered ?? '0'),
      ordersRto: Number(row?.orders_rto ?? '0'),
      prepaidRatio: row?.prepaid_ratio ?? '0.0000',
      repeatOrders: Number(row?.repeat_orders ?? '0'),
      lineIds: row?.line_ids ?? [],
    };
  }

  /**
   * The scheme AS IT STOOD in that period, not as it stands today.
   *
   * `effective_from`/`effective_to` are filtered against the period, so recomputing
   * March in December reproduces March's answer. A scheme change is a new row with
   * a date, never an edit — the same reasoning that makes the ledger append-only.
   */
  private async slabs(client: PoolClient, periodKey: string): Promise<Slab[]> {
    const { rows } = await client.query<{
      min_value: string; max_value: string | null; percent: string; is_provisional: boolean;
    }>(
      `SELECT min_value::text, max_value::text, percent::text, is_provisional
         FROM incentive_slab
        WHERE effective_from <= ($1 || '-01')::date + interval '1 month' - interval '1 day'
          AND (effective_to IS NULL OR effective_to >= ($1 || '-01')::date)
        ORDER BY min_value`,
      [periodKey],
    );
    return rows.map((r) => ({
      minValue: r.min_value,
      maxValue: r.max_value,
      percent: r.percent,
      isProvisional: r.is_provisional,
    }));
  }

  private async modifiers(client: PoolClient, periodKey: string): Promise<Modifier[]> {
    const { rows } = await client.query<{
      kind: Modifier['kind']; threshold_min: string | null; threshold_max: string | null;
      line_id: string | null; value: string; is_provisional: boolean;
    }>(
      `SELECT kind, threshold_min::text, threshold_max::text, line_id, value::text, is_provisional
         FROM incentive_modifier
        WHERE effective_from <= ($1 || '-01')::date + interval '1 month' - interval '1 day'
          AND (effective_to IS NULL OR effective_to >= ($1 || '-01')::date)
        ORDER BY kind, threshold_min`,
      [periodKey],
    );
    return rows.map((r) => ({
      kind: r.kind,
      thresholdMin: r.threshold_min,
      thresholdMax: r.threshold_max,
      lineId: r.line_id,
      value: r.value,
      isProvisional: r.is_provisional,
    }));
  }
}
