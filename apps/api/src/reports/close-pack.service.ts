import { Injectable, Inject } from '@nestjs/common';
import pgLib from 'pg';
import type { Pool, PoolClient } from 'pg';
import { withRlsContext, type RlsSession } from '../db/rls-context.js';
import { IncentiveService } from '../incentive/incentive.service.js';
import { ReportsService, type Period } from './reports.service.js';

/**
 * The month-close pack (docs/04 Monthly, Phase 4 deliverable 1).
 *
 * Nine sections, in the order the doc lists them, because the order is the
 * argument: what was targeted, what was earned, where it came from, and what
 * happens next. Assembled in one call so the pack is internally consistent —
 * nine separate requests could straddle a matview refresh and disagree with each
 * other, which is exactly the "two reports, two answers" problem this replaces.
 *
 * Everything reads the certified views, so the whole pack is back-datable: run
 * March in December and get March (D-161).
 *
 * Section 2 carries the incentive figures, which are PROVISIONAL until O-09 is
 * answered. The flag propagates from the engine to the pack rather than being
 * re-derived, so a close pack cannot present a provisional payable as final.
 */

export interface ClosePack {
  readonly period: Period;
  readonly monthKey: string;
  readonly provisional: boolean;
  readonly sections: Record<string, unknown>;
  readonly caveats: readonly string[];
}

@Injectable()
export class ClosePackService {
  constructor(
    @Inject(pgLib.Pool) private readonly pool: Pool,
    @Inject(IncentiveService) private readonly incentive: IncentiveService,
    @Inject(ReportsService) private readonly reports: ReportsService,
  ) {}

  async build(session: RlsSession, period: Period): Promise<ClosePack> {
    const monthKey = period.to.slice(0, 7);

    const sections = await withRlsContext(this.pool, session, async (client) => ({
      targetVsAchievement: await this.targetVsAchievement(client, period),
      productLinePnl: await this.productLinePnl(client, period),
      skuPerformance: await this.skuPerformance(client, period),
      sourcePnl: await this.sourcePnl(client, period),
      geography: await this.geography(client, period),
      customers: await this.customers(client, period),
      operations: await this.operations(client, period),
      nextMonthPlan: await this.nextMonthPlan(client, period),
    }));

    // Section 2 runs outside the block above because it delegates to the incentive
    // engine, which opens its own RLS context. One statement per rep.
    const { rows: reps } = await this.pool.query<{ employee_id: string }>(
      `SELECT employee_id FROM employee WHERE status = 'ACTIVE' ORDER BY emp_code`,
    );
    const statements = [];
    for (const rep of reps) {
      try {
        statements.push(await this.incentive.statement(session, rep.employee_id, monthKey));
      } catch {
        // A rep whose realised credit falls outside every configured slab throws
        // rather than being paid zero (D-153). One rep's configuration gap must
        // not take down the whole pack — the section reports the gap instead.
        statements.push({ employeeId: rep.employee_id, error: 'No slab covers this rep’s realised credit. Check Master Data.' });
      }
    }

    const provisional = statements.some((s) => 'provisional' in s && s.provisional);

    // RECONCILIATION, because the two numbers WILL look wrong together.
    //
    // Section 1 reports realised VALUE — the full order value delivered. Section 2
    // reports the incentive base, which is realised CREDIT from the ledger. A rep
    // who delivered 153,000 can legitimately have an incentive base of 3,000, and
    // a reader seeing those side by side with no explanation concludes the pack is
    // broken. Three reasons they differ, all of them correct:
    //
    //   1. company_base_value is subtracted. On an UPSELL_DELTA source the rep is
    //      credited only what she added to a cart that already existed (F7).
    //   2. Historical orders imported by ingestion carry no ledger rows at all.
    //      They delivered value; nobody earned credit on them.
    //   3. An order booked with an unconfirmed base price is recorded without a
    //      credit until an admin confirms the price (D-124).
    //
    // So the gap is computed and named rather than left for someone to notice.
    const reconciliation = await withRlsContext(this.pool, session, async (client) => {
      const { rows } = await client.query(
        `SELECT e.full_name AS rep,
                coalesce(sum(k.realised_value), 0)::text  AS realised_value,
                coalesce(sum(k.credit_earned), 0)::text   AS realised_credit,
                (coalesce(sum(k.realised_value), 0) - coalesce(sum(k.credit_earned), 0))::text
                  AS gap,
                coalesce((SELECT count(*) FROM "order" o
                           WHERE o.booked_by_employee_id = e.employee_id
                             AND o.current_status = 'DELIVERED'
                             AND coalesce(o.delivered_date, o.rto_date)
                                 BETWEEN $1::date AND $2::date
                             AND NOT EXISTS (SELECT 1 FROM attribution_ledger al
                                              WHERE al.order_id = o.order_id)), 0)::int
                  AS delivered_without_ledger
           FROM employee e
           LEFT JOIN v_daily_employee_kpi k
                  ON k.employee_id = e.employee_id
                 AND k.kpi_date BETWEEN $1::date AND $2::date
          WHERE e.status = 'ACTIVE'
          GROUP BY e.employee_id, e.full_name
         HAVING coalesce(sum(k.realised_value), 0) <> 0
             OR coalesce(sum(k.credit_earned), 0) <> 0
          ORDER BY e.full_name`,
        [period.from, period.to],
      );
      return rows;
    });

    return {
      period,
      monthKey,
      provisional,
      sections: { incentiveStatements: statements, creditReconciliation: reconciliation, ...sections },
      caveats: [
        ...(provisional
          ? [
              'INCENTIVE FIGURES ARE PROVISIONAL. The slab and modifier values are the proposals in docs/03 §6, not the client’s confirmed scheme (O-09). This pack is not approvable for payment.',
            ]
          : []),
        'Realised VALUE (section 1) and realised CREDIT (section 2) differ by design. Credit excludes company_base_value, and orders imported historically or booked against an unconfirmed base price carry no ledger entry at all. The credit reconciliation section names the gap per rep.',
        'Every figure is derived from the append-only event log, so re-running this pack for the same month will return identical numbers however much later it is run.',
      ],
    };
  }

  /** 1. Target vs Achievement — per rep and team. */
  private async targetVsAchievement(client: PoolClient, period: Period) {
    const { rows } = await client.query(
      `SELECT e.full_name AS rep,
              e.monthly_target::text                AS target,
              coalesce(sum(k.booked_value), 0)::text    AS booked,
              coalesce(sum(k.realised_value), 0)::text  AS realised,
              CASE WHEN e.monthly_target > 0
                   THEN round(coalesce(sum(k.realised_value), 0) / e.monthly_target, 4)
                   ELSE NULL END                    AS achievement_pct,
              coalesce(sum(k.orders_delivered), 0)::int AS orders,
              CASE WHEN sum(k.orders_delivered) > 0
                   THEN round(sum(k.realised_value) / sum(k.orders_delivered), 2)
                   ELSE NULL END                    AS aov,
              (e.monthly_target - coalesce(sum(k.realised_value), 0))::text AS balance
         FROM employee e
         LEFT JOIN v_daily_employee_kpi k
                ON k.employee_id = e.employee_id
               AND k.kpi_date BETWEEN $1::date AND $2::date
        WHERE e.status = 'ACTIVE'
        GROUP BY e.employee_id, e.full_name, e.monthly_target
        ORDER BY coalesce(sum(k.realised_value), 0) DESC`,
      [period.from, period.to],
    );
    return rows;
  }

  /** 3. Product Line P&L — allocated at order_line grain, all seven lines. */
  private async productLinePnl(client: PoolClient, period: Period) {
    const { rows } = await client.query(
      `SELECT pl.name AS product_line,
              coalesce(sum(r.units_delivered), 0)::int  AS units,
              coalesce(sum(r.realised_value), 0)::text  AS realised_value,
              coalesce(sum(r.units_returned), 0)::int   AS units_returned,
              coalesce(sum(r.returned_value), 0)::text  AS returned_value,
              coalesce(sum(r.upsell_units), 0)::int     AS upsell_units
         FROM product_line pl
         LEFT JOIN v_product_revenue_daily r
                ON r.line_id = pl.line_id
               AND r.revenue_date BETWEEN $1::date AND $2::date
        GROUP BY pl.name
        ORDER BY coalesce(sum(r.realised_value), 0) DESC`,
      [period.from, period.to],
    );
    // Every line appears, including the ones that sold nothing. A line missing
    // from a P&L reads as "no data"; a line showing zero reads as "no sales",
    // and only one of those is a finding. F8 was a single product column hiding
    // exactly this.
    return rows;
  }

  /** 4. SKU Performance. */
  private async skuPerformance(client: PoolClient, period: Period) {
    const { rows } = await client.query(
      `SELECT sku_code, product_name, product_line,
              sum(units_delivered)::int   AS units,
              sum(realised_value)::text   AS realised_value,
              CASE WHEN sum(units_delivered) > 0
                   THEN round(sum(realised_value) / sum(units_delivered), 2)
                   ELSE NULL END          AS aov,
              sum(units_returned)::int    AS units_returned,
              CASE WHEN sum(units_delivered) + sum(units_returned) > 0
                   THEN round(sum(units_returned)::numeric
                              / (sum(units_delivered) + sum(units_returned)), 4)
                   ELSE NULL END          AS rto_pct
         FROM v_product_revenue_daily
        WHERE revenue_date BETWEEN $1::date AND $2::date
        GROUP BY sku_code, product_name, product_line
        ORDER BY sum(realised_value) DESC NULLS LAST`,
      [period.from, period.to],
    );
    return rows;
  }

  /** 5. Source P&L. ROI is omitted, not guessed — see the note. */
  private async sourcePnl(client: PoolClient, period: Period) {
    const { rows } = await client.query(
      `SELECT source_code,
              sum(leads_arrived)::int    AS leads,
              sum(orders_delivered)::int AS delivered,
              sum(realised_value)::text  AS realised_value,
              CASE WHEN sum(leads_arrived) > 0
                   THEN round(sum(orders_delivered)::numeric / sum(leads_arrived), 4)
                   ELSE NULL END         AS conversion_pct,
              CASE WHEN sum(leads_arrived) > 0
                   THEN round(sum(realised_value) / sum(leads_arrived), 2)
                   ELSE NULL END         AS value_per_lead
         FROM v_source_funnel_daily
        WHERE funnel_date BETWEEN $1::date AND $2::date
        GROUP BY source_code
        ORDER BY sum(realised_value) DESC NULLS LAST`,
      [period.from, period.to],
    );
    return {
      rows,
      // docs/04 says "ROI where spend entered". No spend is entered anywhere in
      // this system, so ROI is absent rather than computed from a zero — a
      // division that would produce infinity and be believed.
      note: 'ROI and cost per delivered order are omitted: no campaign spend is recorded in the system. They will appear once spend is entered.',
    };
  }

  /** 6. Geography — state performance and RTO hotspots. */
  private async geography(client: PoolClient, period: Period) {
    const { rows: states } = await client.query(
      `SELECT ship_state,
              sum(orders_delivered)::int AS delivered,
              sum(realised_value)::text  AS realised_value,
              sum(rto_count)::int        AS rto_count,
              sum(rto_value)::text       AS rto_value,
              CASE WHEN sum(orders_delivered) + sum(rto_count) > 0
                   THEN round(sum(rto_count)::numeric
                              / (sum(orders_delivered) + sum(rto_count)), 4)
                   ELSE NULL END         AS rto_pct
         FROM v_geography_performance
        WHERE perf_date BETWEEN $1::date AND $2::date
        GROUP BY ship_state
        ORDER BY sum(realised_value) DESC NULLS LAST`,
      [period.from, period.to],
    );

    // Pincode grain is not in a certified view, so it is read from the order
    // table directly and labelled. Top 100 by volume, as docs/04 asks.
    const { rows: pincodes } = await client.query(
      `SELECT o.ship_pincode,
              count(*) FILTER (WHERE o.current_status = 'DELIVERED')::int AS delivered,
              count(*) FILTER (WHERE o.current_status IN ('RTO','RETURNED'))::int AS rto_count
         FROM "order" o
        WHERE o.ship_pincode IS NOT NULL
          AND coalesce(o.delivered_date, o.rto_date) BETWEEN $1::date AND $2::date
        GROUP BY o.ship_pincode
        ORDER BY count(*) DESC
        LIMIT 100`,
      [period.from, period.to],
    );

    return { states, topPincodes: pincodes };
  }

  /** 7. Customer Report — new vs repeat, stage, dormancy. */
  private async customers(client: PoolClient, period: Period) {
    const { rows: [summary] } = await client.query(
      `SELECT count(*) FILTER (WHERE c.customer_type = 'NEW')::int      AS new_customers,
              count(*) FILTER (WHERE c.customer_type = 'EXISTING')::int AS existing_customers,
              count(*) FILTER (WHERE c.lifetime_orders >= 3)::int       AS repeat_buyers,
              coalesce(round(avg(c.lifetime_value) FILTER (WHERE c.lifetime_orders > 0), 2), 0)::text AS avg_ltv
         FROM customer c`,
    );

    const { rows: stages } = await client.query(
      `SELECT stage, count(*)::int AS customers,
              coalesce(sum(lifetime_value), 0)::text AS lifetime_value
         FROM customer GROUP BY stage ORDER BY count(*) DESC`,
    );

    // Dormant: delivered before, nothing since, and past their reorder date.
    const { rows: dormant } = await client.query(
      `SELECT count(*)::int AS dormant_customers
         FROM customer
        WHERE lifetime_orders > 0
          AND last_order_date < CURRENT_DATE - 120
          AND NOT do_not_call`,
    );

    return { summary, byStage: stages, dormant: dormant[0] };
  }

  /** 8. Operations — dispatch TAT, couriers, NDR, RTO recovery. */
  private async operations(client: PoolClient, period: Period) {
    const { rows: [tat] } = await client.query(
      `SELECT round(avg(EXTRACT(epoch FROM (d.event_at - b.event_at)) / 86400)::numeric, 2)::text
                AS avg_days_book_to_dispatch
         FROM order_status_event b
         JOIN order_status_event d ON d.order_id = b.order_id AND d.to_status = 'DISPATCHED'
        WHERE b.to_status = 'PENDING'
          AND d.event_at::date BETWEEN $1::date AND $2::date`,
      [period.from, period.to],
    );

    const { rows: couriers } = await client.query(
      `SELECT coalesce(o.courier_partner, 'UNRECORDED') AS courier,
              count(*) FILTER (WHERE o.current_status = 'DELIVERED')::int AS delivered,
              count(*) FILTER (WHERE o.current_status IN ('RTO','RETURNED'))::int AS rto
         FROM "order" o
        WHERE coalesce(o.delivered_date, o.rto_date) BETWEEN $1::date AND $2::date
        GROUP BY 1 ORDER BY 2 DESC`,
      [period.from, period.to],
    );

    // NDR states are not terminal — the whole point of the RTO_RECOVERY and
    // NC_REFUSED channels is that a failed attempt can still be worked.
    const { rows: ndr } = await client.query(
      `SELECT e.to_status AS ndr_state, count(*)::int AS events
         FROM order_status_event e
        WHERE e.to_status IN ('FAILED_DELIVERY','NO_RESPONSE','REFUSED')
          AND e.event_at::date BETWEEN $1::date AND $2::date
        GROUP BY 1 ORDER BY 2 DESC`,
      [period.from, period.to],
    );

    const { rows: [recovery] } = await client.query(
      `SELECT count(*) FILTER (WHERE o.current_status = 'DELIVERED')::int AS recovered,
              count(*)::int AS entered_ndr
         FROM "order" o
        WHERE EXISTS (
          SELECT 1 FROM order_status_event e
           WHERE e.order_id = o.order_id
             AND e.to_status IN ('FAILED_DELIVERY','NO_RESPONSE','REFUSED')
             AND e.event_at::date BETWEEN $1::date AND $2::date
        )`,
      [period.from, period.to],
    );

    return { tat, couriers, ndr, recovery };
  }

  /** 9. Next-Month Plan — what each rep must run at, and what is already queued. */
  private async nextMonthPlan(client: PoolClient, period: Period) {
    const { rows: pipeline } = await client.query(
      `SELECT e.full_name AS rep,
              count(*) FILTER (WHERE NOT l.is_converted AND l.closed_at IS NULL)::int AS open_leads,
              count(*) FILTER (WHERE c.next_due_date IS NOT NULL)::int AS repeat_due
         FROM employee e
         LEFT JOIN lead l ON l.assigned_to = e.employee_id
         LEFT JOIN customer c ON c.owner_employee_id = e.employee_id
        WHERE e.status = 'ACTIVE'
        GROUP BY e.full_name ORDER BY e.full_name`,
    );

    const { rows: [repeatQueue] } = await client.query(
      `SELECT count(*)::int AS due_next_30_days
         FROM v_repeat_due_queue
        WHERE next_due_date <= CURRENT_DATE + 30`,
    );

    return { pipeline, repeatQueue };
  }
}
