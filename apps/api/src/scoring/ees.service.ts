import { Injectable, Inject } from '@nestjs/common';
import pgLib from 'pg';
import type { Pool, PoolClient } from 'pg';
import { withRlsContext, type RlsSession } from '../db/rls-context.js';
import { computeScores, observedTotals, type CohortStat, type ComponentKey, type RepScore } from './ees.js';

/**
 * Nightly EES run (docs/03 §5, Phase 3 deliverable 4).
 *
 * Gathers raw counts per (rep × lead source) and hands them to the pure scorer.
 * No arithmetic anyone has to trust lives in this file — it counts and divides,
 * and every judgement is in ees.ts where it can be tested without a database.
 *
 * "Reports on reps. Does not assign leads." Nothing here writes to `lead`.
 */

export interface ScoringRunResult {
  readonly scoreDate: string;
  readonly repsScored: number;
  readonly scores: readonly RepScore[];
}

@Injectable()
export class EesService {
  constructor(@Inject(pgLib.Pool) private readonly pool: Pool) {}

  async run(session: RlsSession, scoreDate: string): Promise<ScoringRunResult> {
    return withRlsContext(this.pool, session, async (client) => {
      const cohorts = await this.cohorts(client, scoreDate);
      const scores = computeScores(cohorts);
      await this.persist(client, scoreDate, cohorts, scores);
      return { scoreDate, repsScored: scores.length, scores };
    });
  }

  /**
   * One row per (rep × source) for the period containing `scoreDate`.
   *
   * The window is the calendar month, matching the ledger's `period_key`. A
   * rolling 30-day window would give a different answer depending on the day it
   * ran, which is not something anyone can reconcile against a monthly report.
   */
  private async cohorts(client: PoolClient, scoreDate: string): Promise<CohortStat[]> {
    const { rows } = await client.query<CohortRow>(
      `WITH period AS (
         SELECT date_trunc('month', $1::date)::date AS from_date,
                (date_trunc('month', $1::date) + interval '1 month - 1 day')::date AS to_date
       ), assigned AS (
         SELECT l.assigned_to AS employee_id, l.source_id,
                count(*) AS leads,
                count(*) FILTER (WHERE EXISTS (
                  SELECT 1 FROM activity a WHERE a.lead_id = l.lead_id
                )) AS touched,
                count(*) FILTER (WHERE EXISTS (
                  SELECT 1 FROM activity a
                   WHERE a.lead_id = l.lead_id AND a.disposition_id IS NOT NULL
                )) AS dispositioned,
                count(*) FILTER (WHERE EXISTS (
                  SELECT 1 FROM activity a
                   WHERE a.lead_id = l.lead_id AND coalesce(btrim(a.remark_raw), '') <> ''
                )) AS with_remarks
           FROM lead l, period p
          WHERE l.assigned_to IS NOT NULL
            AND l.assigned_at::date BETWEEN p.from_date AND p.to_date
          GROUP BY l.assigned_to, l.source_id
       ), credit AS (
         -- Collapsed to ONE ROW PER ORDER before it is joined to anything.
         --
         -- The first version joined attribution_ledger straight onto the order
         -- table, and the join fanned out: every order carries a BOOKED_CREDIT
         -- and a REALISED_CREDIT, and a returned one also carries a CLAWBACK. So
         -- the delivered count counted order-times-ledger-row, and a rep with
         -- three delivered orders was recorded with six. It surfaced as a
         -- conversion rate of 2.0 — a rate above 1 was the only reason anyone
         -- looked. (Backticks are deliberately absent here: this SQL lives in a
         -- JS template literal, and one would end the string.)
         SELECT order_id, employee_id,
                coalesce(sum(employee_credited_value) FILTER (WHERE is_realised), 0) AS credited
           FROM attribution_ledger
          GROUP BY order_id, employee_id
       ), orders AS (
         SELECT o.booked_by_employee_id AS employee_id, l.source_id,
                count(*) FILTER (WHERE o.current_status = 'DELIVERED') AS delivered,
                count(*) FILTER (WHERE o.current_status IN ('RTO','RETURNED')) AS rto,
                coalesce(sum(o.final_value) FILTER (WHERE o.current_status = 'DELIVERED'), 0) AS realised,
                coalesce(sum(cr.credited), 0) AS credited,
                coalesce(sum(o.company_base_value) FILTER (WHERE o.current_status = 'DELIVERED'), 0) AS base
           FROM "order" o
           JOIN lead l ON l.lead_id = o.lead_id
           LEFT JOIN credit cr
                  ON cr.order_id = o.order_id AND cr.employee_id = o.booked_by_employee_id
          CROSS JOIN period p
          WHERE o.booked_by_employee_id IS NOT NULL
            AND coalesce(o.delivered_date, o.rto_date) BETWEEN p.from_date AND p.to_date
          GROUP BY o.booked_by_employee_id, l.source_id
       )
       SELECT a.employee_id, a.source_id, a.leads::text AS leads_assigned,
              coalesce(o.delivered, 0)::text AS delivered,
              coalesce(o.rto, 0)::text       AS rto,
              coalesce(o.realised, 0)::text  AS realised_value,
              coalesce(o.credited, 0)::text  AS credited_value,
              coalesce(o.base, 0)::text      AS base_value,
              a.touched::text                AS touched,
              a.dispositioned::text          AS dispositioned,
              a.with_remarks::text           AS with_remarks,
              (coalesce(o.delivered, 0)::numeric / greatest(a.leads, 1))::text AS conversion,
              (coalesce(o.realised, 0) / greatest(a.leads, 1))::text AS value_per_lead,
              (1 - (coalesce(o.rto, 0)::numeric
                    / greatest(coalesce(o.delivered, 0) + coalesce(o.rto, 0), 1)))::text
                AS delivery_quality,
              (CASE WHEN coalesce(o.base, 0) > 0
                    THEN coalesce(o.credited, 0) / o.base ELSE 1 END)::text AS upsell_index,
              (a.touched::numeric / greatest(a.leads, 1))::text AS activity_discipline,
              (((a.dispositioned::numeric / greatest(a.leads, 1))
                + (a.with_remarks::numeric / greatest(a.leads, 1))) / 2)::text AS data_hygiene
         FROM assigned a
         LEFT JOIN orders o
           ON o.employee_id = a.employee_id AND o.source_id = a.source_id`,
      [scoreDate],
    );

    return rows.map((r) => ({
      employeeId: r.employee_id,
      sourceId: r.source_id,
      leadsAssigned: Number(r.leads_assigned),
      values: {
        score_conversion_rate: Number(r.conversion),
        score_value_per_lead: Number(r.value_per_lead),
        score_delivery_quality: Number(r.delivery_quality),
        score_upsell_index: Number(r.upsell_index),
        score_activity_discipline: Number(r.activity_discipline),
        score_data_hygiene: Number(r.data_hygiene),
      } as Record<ComponentKey, number>,
      counts: {
        delivered: Number(r.delivered),
        rto: Number(r.rto),
        realisedValue: Number(r.realised_value),
        creditedValue: Number(r.credited_value),
        baseValue: Number(r.base_value),
        touched: Number(r.touched),
        dispositioned: Number(r.dispositioned),
        withRemarks: Number(r.with_remarks),
      },
    }));
  }

  /**
   * `employee_score_daily` is keyed on (employee, date) and is DERIVED, so a
   * re-run overwrites rather than appending. It is deliberately not in the
   * append-only set: nothing is paid from it, and a score recomputed after a data
   * correction should replace the wrong one rather than sit beside it.
   */
  private async persist(
    client: PoolClient,
    scoreDate: string,
    cohorts: readonly CohortStat[],
    scores: readonly RepScore[],
  ): Promise<void> {
    for (const s of scores) {
      const mine = cohorts.filter((c) => c.employeeId === s.employeeId);

      // OBSERVED values, not the scored ones. These columns are named after
      // metrics with dictionary definitions, and a report reading `rto_pct` must
      // get this rep's RTO rate — not a shrunk, source-neutralised artefact of it.
      //
      // The first version stored the scored values here and it showed immediately:
      // a rep with three deliveries and ZERO returns was recorded at rto_pct
      // 0.2182, because shrinkage had pulled her toward a team mean that included
      // someone else's RTO. Correct as an input to a ranking, wrong as a fact.
      const observed = observedTotals(mine);

      await client.query(
        `INSERT INTO employee_score_daily
           (employee_id, score_date, leads_assigned, conversion_pct, upsell_index,
            rto_pct, followup_sla_pct, data_hygiene_pct, efficiency_score, shrinkage_applied)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)
         ON CONFLICT (employee_id, score_date) DO UPDATE SET
           leads_assigned    = EXCLUDED.leads_assigned,
           conversion_pct    = EXCLUDED.conversion_pct,
           upsell_index      = EXCLUDED.upsell_index,
           rto_pct           = EXCLUDED.rto_pct,
           followup_sla_pct  = EXCLUDED.followup_sla_pct,
           data_hygiene_pct  = EXCLUDED.data_hygiene_pct,
           efficiency_score  = EXCLUDED.efficiency_score,
           shrinkage_applied = EXCLUDED.shrinkage_applied`,
        [
          s.employeeId,
          scoreDate,
          observed.leadsAssigned,
          observed.conversionPct.toFixed(4),
          observed.upsellIndex.toFixed(3),
          observed.rtoPct.toFixed(4),
          observed.followupSlaPct.toFixed(4),
          observed.dataHygienePct.toFixed(4),
          // The one column that IS a scored figure, and is named accordingly.
          s.score.toFixed(2),
          s.shrinkageApplied,
        ],
      );
    }
  }
}

interface CohortRow {
  employee_id: string;
  source_id: string;
  leads_assigned: string;
  delivered: string;
  rto: string;
  realised_value: string;
  credited_value: string;
  base_value: string;
  touched: string;
  dispositioned: string;
  with_remarks: string;
  conversion: string;
  value_per_lead: string;
  delivery_quality: string;
  upsell_index: string;
  activity_discipline: string;
  data_hygiene: string;
}
