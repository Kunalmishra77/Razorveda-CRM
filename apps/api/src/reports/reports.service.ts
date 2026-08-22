import { Injectable, Inject, BadRequestException } from '@nestjs/common';
import pgLib from 'pg';
import type { Pool, PoolClient } from 'pg';
import { withRlsContext, type RlsSession } from '../db/rls-context.js';
import { computeTargets, targetMovementPercent } from './targets.js';

/**
 * The daily reports (docs/04, Phase 4 deliverable 1).
 *
 * THE RULE THIS FILE EXISTS TO OBEY: "No report computes its own arithmetic. All
 * read certified views." So every query here is a SELECT with a date filter and a
 * SUM — no ratios are recomputed, no thresholds re-applied, no money re-derived.
 * If a number looks wrong, it is wrong in `packages/metrics/sql/views.sql`, in one
 * place, for every report at once.
 *
 * Every report takes a period and works for any historical range. The views are
 * built from the append-only event log (D-161), so a range in the past returns
 * what was true then, not what is true now.
 *
 * Reports read the `v_` wrappers, never `mv_` directly. The matviews are revoked
 * from app_role because a matview cannot carry an RLS policy (D-163) — reaching
 * around the wrapper would hand a rep the whole team's numbers.
 */

export interface Period {
  readonly from: string;
  readonly to: string;
}

export function parsePeriod(from?: string, to?: string): Period {
  const iso = /^\d{4}-\d{2}-\d{2}$/;
  if (!from || !iso.test(from) || !to || !iso.test(to)) {
    throw new BadRequestException(
      'Give a period as from=YYYY-MM-DD&to=YYYY-MM-DD, e.g. from=2026-08-01&to=2026-08-31.',
    );
  }
  if (from > to) {
    throw new BadRequestException(`The period starts after it ends: ${from} to ${to}.`);
  }
  return { from, to };
}

@Injectable()
export class ReportsService {
  constructor(@Inject(pgLib.Pool) private readonly pool: Pool) {}

  /**
   * Employee Daily Performance (docs/04, exact column list).
   *
   * Self-reported columns keep their `_self_reported` suffix all the way to the
   * response. docs/04 requires the UI to mark them, and a name that carries the
   * caveat is harder to render without it than a flag in a sibling field.
   */
  async employeePerformance(session: RlsSession, period: Period) {
    return this.read(session, async (client) => {
      const { rows } = await client.query(
        `SELECT e.full_name AS rep,
                sum(k.leads_assigned)::int          AS leads_assigned,
                sum(k.leads_touched)::int           AS leads_touched,
                sum(k.leads_untouched)::int         AS untouched,
                sum(k.dials_self_reported)::int     AS dials_self_reported,
                sum(k.connects_self_reported)::int  AS connects_self_reported,
                CASE WHEN sum(k.dials_self_reported) > 0
                     THEN round(sum(k.connects_self_reported)::numeric
                                / sum(k.dials_self_reported), 4)
                     ELSE NULL END                  AS connectivity_pct_self_reported,
                sum(k.cd)::int                      AS cd,
                sum(k.nd)::int                      AS nd,
                sum(k.orders_booked)::int           AS orders_booked,
                sum(k.booked_value)::text           AS booked_value,
                sum(k.orders_delivered)::int        AS orders_delivered,
                sum(k.realised_value)::text         AS realised_value,
                sum(k.rto_count)::int               AS rto_count,
                sum(k.rto_value)::text              AS rto_value,
                CASE WHEN sum(k.orders_delivered) + sum(k.rto_count) > 0
                     THEN round(sum(k.rto_count)::numeric
                                / (sum(k.orders_delivered) + sum(k.rto_count)), 4)
                     ELSE NULL END                  AS rto_pct,
                CASE WHEN sum(k.orders_delivered) > 0
                     THEN round(sum(k.realised_value) / sum(k.orders_delivered), 2)
                     ELSE NULL END                  AS aov,
                sum(k.credit_earned)::text          AS credit_earned,
                sum(k.dispositions_filled)::int     AS dispositions_filled
           FROM v_daily_employee_kpi k
           JOIN employee e ON e.employee_id = k.employee_id
          WHERE k.kpi_date BETWEEN $1::date AND $2::date
          GROUP BY e.full_name
          ORDER BY sum(k.realised_value) DESC, e.full_name`,
        [period.from, period.to],
      );
      return rows;
    });
  }

  /** Daily Sales Register — every order in the period, with the credit split shown. */
  async salesRegister(session: RlsSession, period: Period) {
    return this.read(session, async (client) => {
      const { rows } = await client.query(
        `SELECT o.order_number, o.order_date, c.full_name AS customer,
                s.code AS source, e.full_name AS rep,
                o.final_value::text, o.company_base_value::text,
                (o.final_value - o.company_base_value)::text AS employee_credited_value,
                o.payment_mode, o.prepaid_amount::text, o.cod_amount::text,
                o.ship_state, o.current_status,
                string_agg(sk.product_name, ', ' ORDER BY sk.product_name) AS products
           FROM "order" o
           JOIN customer c ON c.customer_id = o.customer_id
           JOIN lead_source s ON s.source_id = o.source_id
           LEFT JOIN employee e ON e.employee_id = o.booked_by_employee_id
           LEFT JOIN order_line ol ON ol.order_id = o.order_id
           LEFT JOIN sku sk ON sk.sku_id = ol.sku_id
          WHERE o.order_date BETWEEN $1::date AND $2::date
          GROUP BY o.order_id, c.full_name, s.code, e.full_name
          ORDER BY o.order_date DESC, o.order_number`,
        [period.from, period.to],
      );
      return rows;
    });
  }

  /** Daily Lead Pool — what arrived, what was assigned, what is ageing. */
  async leadPool(session: RlsSession, period: Period) {
    return this.read(session, async (client) => {
      const { rows } = await client.query(
        `SELECT f.source_code,
                sum(f.leads_arrived)::int      AS arrived,
                sum(f.leads_assigned)::int     AS assigned,
                sum(f.leads_unassigned)::int   AS still_unassigned,
                sum(f.leads_converted)::int    AS converted,
                sum(f.orders_delivered)::int   AS delivered,
                sum(f.realised_value)::text    AS realised_value,
                CASE WHEN sum(f.leads_arrived) > 0
                     THEN round(sum(f.orders_delivered)::numeric / sum(f.leads_arrived), 4)
                     ELSE NULL END             AS conversion_pct
           FROM v_source_funnel_daily f
          WHERE f.funnel_date BETWEEN $1::date AND $2::date
          GROUP BY f.source_code
          ORDER BY sum(f.leads_arrived) DESC`,
        [period.from, period.to],
      );

      // Ageing is about NOW, not about the period: an admin asks "what is sitting
      // in the pool at this moment", and answering it for a historical range would
      // be a different question nobody asked.
      const { rows: [ageing] } = await client.query(
        `SELECT count(*) FILTER (WHERE l.received_at < now() - interval '24 hours')::int AS over_24h,
                count(*)::int AS unassigned_total
           FROM lead l
          WHERE l.assigned_to IS NULL AND NOT l.is_converted AND l.closed_at IS NULL`,
      );

      return { bySource: rows, poolNow: ageing };
    });
  }

  /** Management One-Pager — the whole business on one screen. */
  async managementOnePager(session: RlsSession, period: Period) {
    return this.read(session, async (client) => {
      const { rows: [totals] } = await client.query(
        `SELECT coalesce(sum(k.realised_value), 0)::text AS realised_value,
                coalesce(sum(k.booked_value), 0)::text   AS booked_value,
                coalesce(sum(k.orders_delivered), 0)::int AS orders_delivered,
                coalesce(sum(k.orders_booked), 0)::int    AS orders_booked,
                coalesce(sum(k.rto_count), 0)::int        AS rto_count,
                CASE WHEN sum(k.orders_delivered) + sum(k.rto_count) > 0
                     THEN round(sum(k.rto_count)::numeric
                                / (sum(k.orders_delivered) + sum(k.rto_count)), 4)
                     ELSE NULL END                        AS rto_pct
           FROM v_daily_employee_kpi k
          WHERE k.kpi_date BETWEEN $1::date AND $2::date`,
        [period.from, period.to],
      );

      const { rows: [topRep] } = await client.query(
        `SELECT e.full_name, sum(k.realised_value)::text AS realised_value
           FROM v_daily_employee_kpi k JOIN employee e ON e.employee_id = k.employee_id
          WHERE k.kpi_date BETWEEN $1::date AND $2::date
          GROUP BY e.full_name ORDER BY sum(k.realised_value) DESC NULLS LAST LIMIT 1`,
        [period.from, period.to],
      );

      const { rows: [topProduct] } = await client.query(
        `SELECT product_name, sum(realised_value)::text AS realised_value
           FROM v_product_revenue_daily
          WHERE revenue_date BETWEEN $1::date AND $2::date
          GROUP BY product_name ORDER BY sum(realised_value) DESC NULLS LAST LIMIT 1`,
        [period.from, period.to],
      );

      return {
        totals,
        topRep: topRep ?? null,
        topProduct: topProduct ?? null,
      };
    });
  }

  /** Daily Dispatch & Status — what is moving, and what is stuck. */
  async dispatchStatus(session: RlsSession, period: Period) {
    return this.read(session, async (client) => {
      const { rows: movement } = await client.query(
        `SELECT e.to_status AS status, count(*)::int AS orders,
                coalesce(sum(o.final_value), 0)::text AS value
           FROM order_status_event e
           JOIN "order" o ON o.order_id = e.order_id
          WHERE e.event_at::date BETWEEN $1::date AND $2::date
          GROUP BY e.to_status ORDER BY count(*) DESC`,
        [period.from, period.to],
      );

      // Stuck is a question about now, like pool ageing. An order whose last event
      // is more than seven days old and is not in a terminal state has been
      // forgotten by somebody.
      const { rows: stuck } = await client.query(
        `SELECT o.order_number, o.current_status,
                max(e.event_at)::date AS last_moved,
                (CURRENT_DATE - max(e.event_at)::date) AS days_stuck,
                o.final_value::text
           FROM "order" o JOIN order_status_event e ON e.order_id = o.order_id
          WHERE o.current_status NOT IN ('DELIVERED','RTO','RETURNED','CANCELLED')
          GROUP BY o.order_id
         HAVING max(e.event_at) < now() - interval '7 days'
          ORDER BY max(e.event_at)
          LIMIT 100`,
      );

      return { movement, stuck };
    });
  }

  /** Source Performance (docs/04, weekly) — leads by channel and what they yield. */
  async sourcePerformance(session: RlsSession, period: Period) {
    return this.read(session, async (client) => {
      const { rows } = await client.query(
        `SELECT source_code,
                sum(leads_arrived)::int      AS leads,
                sum(orders_delivered)::int   AS delivered,
                sum(realised_value)::text    AS realised_value,
                sum(rto_count)::int          AS rto_count,
                CASE WHEN sum(leads_arrived) > 0
                     THEN round(sum(orders_delivered)::numeric / sum(leads_arrived), 4)
                     ELSE NULL END           AS conversion_pct,
                CASE WHEN sum(leads_arrived) > 0
                     THEN round(sum(realised_value) / sum(leads_arrived), 2)
                     ELSE NULL END           AS value_per_lead
           FROM v_source_funnel_daily
          WHERE funnel_date BETWEEN $1::date AND $2::date
          GROUP BY source_code
          ORDER BY sum(realised_value) DESC NULLS LAST`,
        [period.from, period.to],
      );
      return rows;
    });
  }

  /**
   * Assignment Quality (docs/04) — "the report that makes manual assignment
   * better each week".
   *
   * The one report whose whole purpose is to be acted on. D-02 removed the
   * allocation engine at the client's request, so assignment stays a human
   * decision; this is what makes that decision informed rather than habitual.
   *
   * Yield is realised value per lead, not a conversion count. A rep who converts
   * fewer META_ADS leads at triple the value is better at META_ADS, and counting
   * conversions would say the opposite.
   */
  async assignmentQuality(session: RlsSession, period: Period) {
    return this.read(session, async (client) => {
      const { rows } = await client.query(
        `WITH per_source AS (
           SELECT l.assigned_to AS employee_id, s.code AS source_code,
                  count(DISTINCT l.lead_id) AS leads,
                  count(DISTINCT o.order_id) FILTER (WHERE o.current_status = 'DELIVERED') AS delivered,
                  coalesce(sum(o.final_value) FILTER (WHERE o.current_status = 'DELIVERED'), 0) AS realised,
                  count(DISTINCT o.order_id) FILTER (WHERE o.current_status IN ('RTO','RETURNED')) AS rto
             FROM lead l
             JOIN lead_source s ON s.source_id = l.source_id
             LEFT JOIN "order" o ON o.lead_id = l.lead_id
            WHERE l.assigned_to IS NOT NULL
              AND l.assigned_at::date BETWEEN $1::date AND $2::date
            GROUP BY l.assigned_to, s.code
         ), yielded AS (
           SELECT employee_id, source_code, leads, delivered, rto,
                  (realised / greatest(leads, 1)) AS yield_per_lead
             FROM per_source
         )
         SELECT e.full_name AS rep,
                (SELECT source_code FROM yielded y WHERE y.employee_id = e.employee_id
                  ORDER BY yield_per_lead DESC LIMIT 1) AS best_source,
                (SELECT round(yield_per_lead, 2)::text FROM yielded y WHERE y.employee_id = e.employee_id
                  ORDER BY yield_per_lead DESC LIMIT 1) AS best_yield,
                (SELECT source_code FROM yielded y WHERE y.employee_id = e.employee_id
                  ORDER BY yield_per_lead ASC LIMIT 1) AS weakest_source,
                (SELECT round(yield_per_lead, 2)::text FROM yielded y WHERE y.employee_id = e.employee_id
                  ORDER BY yield_per_lead ASC LIMIT 1) AS weakest_yield,
                (SELECT pl.name FROM "order" o
                   JOIN order_line ol ON ol.order_id = o.order_id
                   JOIN sku sk ON sk.sku_id = ol.sku_id
                   JOIN product_line pl ON pl.line_id = sk.line_id
                  WHERE o.booked_by_employee_id = e.employee_id
                    AND o.current_status = 'DELIVERED'
                    AND o.order_date BETWEEN $1::date AND $2::date
                  GROUP BY pl.name ORDER BY sum(ol.line_value) DESC LIMIT 1) AS best_product_line,
                (SELECT sum(leads)::int FROM yielded y WHERE y.employee_id = e.employee_id) AS leads,
                (SELECT sum(rto)::int   FROM yielded y WHERE y.employee_id = e.employee_id) AS rto_count
           FROM employee e
          WHERE EXISTS (SELECT 1 FROM yielded y WHERE y.employee_id = e.employee_id)
          ORDER BY e.full_name`,
        [period.from, period.to],
      );
      return rows;
    });
  }

  /** Weekly Team Pack (docs/04) — the week against target, per rep. */
  async weeklyTeamPack(session: RlsSession, period: Period) {
    return this.read(session, async (client) => {
      const { rows } = await client.query(
        `SELECT e.full_name AS rep,
                sum(k.leads_assigned)::int   AS leads_assigned,
                sum(k.orders_booked)::int    AS orders_booked,
                sum(k.booked_value)::text    AS booked_value,
                sum(k.orders_delivered)::int AS orders_delivered,
                sum(k.realised_value)::text  AS realised_value,
                sum(k.rto_count)::int        AS rto_count,
                sum(k.credit_earned)::text   AS credit_earned,
                e.monthly_target::text       AS monthly_target
           FROM v_daily_employee_kpi k
           JOIN employee e ON e.employee_id = k.employee_id
          WHERE k.kpi_date BETWEEN $1::date AND $2::date
          GROUP BY e.full_name, e.monthly_target
          ORDER BY sum(k.realised_value) DESC NULLS LAST`,
        [period.from, period.to],
      );
      return rows;
    });
  }

  /**
   * THE TARGET COMPARISON (deliverable 5, F11) — read-only, and deliberately so.
   *
   * Shows what the sheet asks of each rep today (flat x1.15) beside what the
   * corrected rule asks, and how far apart they are. NOTHING IS SWITCHED ON by
   * calling this: it changes what seven people are measured against, so the
   * client sees the movement before it moves.
   *
   * Rolling RTO is 90 days ending at the period end, taken from the certified
   * view — so this report is as reproducible as every other (D-161).
   */
  async targetComparison(session: RlsSession, period: Period) {
    return this.read(session, async (client) => {
      const { rows: [days] } = await client.query<{ elapsed: string; remaining: string }>(
        `SELECT count(*) FILTER (WHERE calendar_date <= $1::date)::text AS elapsed,
                count(*) FILTER (WHERE calendar_date >  $1::date)::text AS remaining
           FROM working_calendar
          WHERE is_working_day
            AND calendar_date >= date_trunc('month', $1::date)::date
            AND calendar_date <  (date_trunc('month', $1::date) + interval '1 month')::date`,
        [period.to],
      );

      const { rows } = await client.query<{
        full_name: string; monthly_target: string | null;
        realised_value: string; rolling_rto: string; shipped_orders: string;
      }>(
        `SELECT e.full_name, e.monthly_target::text,
                coalesce((SELECT sum(k.realised_value) FROM v_daily_employee_kpi k
                           WHERE k.employee_id = e.employee_id
                             AND k.kpi_date >= date_trunc('month', $1::date)::date
                             AND k.kpi_date <= $1::date), 0)::text AS realised_value,
                coalesce((SELECT CASE WHEN sum(k.orders_delivered) + sum(k.rto_count) > 0
                                      THEN sum(k.rto_count)::numeric
                                           / (sum(k.orders_delivered) + sum(k.rto_count))
                                      ELSE 0 END
                            FROM v_daily_employee_kpi k
                           WHERE k.employee_id = e.employee_id
                             AND k.kpi_date BETWEEN $1::date - 90 AND $1::date), 0)::text
                  AS rolling_rto,
                -- Shipped orders in the same window. A rep with none has an
                -- UNKNOWN rate, not a zero one, and the difference is a 13%
                -- target cut handed out for having no record at all.
                coalesce((SELECT sum(k.orders_delivered) + sum(k.rto_count)
                            FROM v_daily_employee_kpi k
                           WHERE k.employee_id = e.employee_id
                             AND k.kpi_date BETWEEN $1::date - 90 AND $1::date), 0)::text
                  AS shipped_orders
           FROM employee e
          WHERE e.status = 'ACTIVE'
          ORDER BY e.full_name`,
        [period.to],
      );

      // The team's own rolling rate, used as the prior for anyone with no record.
      const { rows: [team] } = await client.query<{ rolling_rto: string }>(
        `SELECT coalesce(CASE WHEN sum(orders_delivered) + sum(rto_count) > 0
                              THEN sum(rto_count)::numeric
                                   / (sum(orders_delivered) + sum(rto_count))
                              ELSE 0 END, 0)::text AS rolling_rto
           FROM v_daily_employee_kpi
          WHERE kpi_date BETWEEN $1::date - 90 AND $1::date`,
        [period.to],
      );
      const teamRollingRto = Number(team?.rolling_rto ?? '0');

      const reps = rows.map((r) => {
        const breakdown = computeTargets({
          monthlyTarget: r.monthly_target ?? '0',
          realisedValue: r.realised_value,
          remainingWorkingDays: Number(days?.remaining ?? '0'),
          elapsedWorkingDays: Number(days?.elapsed ?? '0'),
          rollingRto: Number(r.rolling_rto),
          shippedOrders: Number(r.shipped_orders),
          teamRollingRto,
        });
        return {
          rep: r.full_name,
          // The EFFECTIVE rate the figure was built from, not the raw query value.
          // Printing the raw 0% beside a +3.5% uplift reads as a bug; the reader
          // needs the number the arithmetic actually used, plus the flag saying
          // where it came from.
          rolling_rto: breakdown.rollingRto,
          rolling_rto_observed: Number(r.rolling_rto),
          shipped_orders: Number(r.shipped_orders),
          monthly_target: breakdown.monthlyTarget,
          realised_value: breakdown.realisedValue,
          value_balance: breakdown.valueBalance,
          per_day_req_delivery: breakdown.perDayReqDelivery,
          required_booking_today: breakdown.requiredBookingLegacy,
          required_booking_corrected: breakdown.requiredBookingCorrected,
          movement_pct: targetMovementPercent(breakdown),
          rto_capped: breakdown.rtoCapped,
          rto_from_team: breakdown.rtoFromTeam,
          notes: breakdown.notes,
        };
      });

      return {
        rows: reps,
        workingDays: {
          elapsed: Number(days?.elapsed ?? '0'),
          remaining: Number(days?.remaining ?? '0'),
        },
        teamRollingRto,
        caveats: [
          'COMPARISON ONLY. Nothing is switched on by this report. "Required Booking Today" is the flat x1.15 the sheet uses now; "Corrected" is Per Day Req Delivery / (1 - rolling 90-day RTO).',
          'Expect the corrected figure to RISE sharply for high-RTO reps and FALL for low-RTO ones. That is the point of the correction (F11), not a fault in it.',
        ],
      };
    });
  }

  private async read<T>(session: RlsSession, fn: (c: PoolClient) => Promise<T>): Promise<T> {
    return withRlsContext(this.pool, session, fn);
  }
}
