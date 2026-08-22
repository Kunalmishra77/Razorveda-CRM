import { Injectable, Inject } from '@nestjs/common';
import pgLib from 'pg';
import type { Pool, PoolClient } from 'pg';
import { UNTOUCHED_ALERT_HOURS, UNTOUCHED_RECALL_HOURS } from '@razorveda/shared';
import { withRlsContext, type RlsSession } from '../db/rls-context.js';

/**
 * Untouched-lead handling (Phase 3 deliverable 6, docs/02).
 *
 *   48h untouched  → the admin is alerted
 *   72h untouched  → the lead returns to the pool, with a RECALL row
 *
 * This is the ONLY automatic movement the system performs. D-02 removed the
 * allocation engine entirely: leads land unassigned and an admin distributes
 * them. The one exception is a lead nobody has touched, because the alternative
 * is a lead quietly rotting on one rep's list while the customer waits.
 *
 * WHAT "UNTOUCHED" MEANS, precisely:
 *
 * No activity recorded against the lead SINCE it was assigned. Not "no activity
 * ever" — a lead transferred from one rep to another starts its clock again, and
 * the previous rep's calls must not buy the new one three free days. `assigned_at`
 * is the reference point, and it moves on every reassignment.
 *
 * THE 48h ALERT IS A QUERY, NOT AN EVENT.
 *
 * There is no notification table and this does not add one. An untouched lead is
 * derivable from state that already exists, so storing an "alert fired" row would
 * create a second source of truth that can disagree with the leads themselves —
 * and would need its own cleanup when the rep finally calls. Phase 4 owns
 * notification DELIVERY; Phase 3 owns detection. `findUntouched` is what a Phase 4
 * digest or an admin dashboard reads.
 */

export interface UntouchedLead {
  readonly leadId: string;
  readonly customerName: string | null;
  readonly assignedTo: string;
  readonly repName: string;
  readonly hoursUntouched: number;
}

export interface RecallResult {
  readonly asOf: string;
  readonly recalled: number;
  readonly leads: readonly { leadId: string; fromRep: string }[];
}

@Injectable()
export class FollowupService {
  constructor(@Inject(pgLib.Pool) private readonly pool: Pool) {}

  /**
   * Leads past the alert threshold but not yet recalled.
   *
   * Admin-facing, so it runs in the caller's RLS context — an admin sees every
   * rep's leads because `is_admin()` says so, not because this query opted out of
   * the policy. A rep calling it sees only her own, which is the right answer for
   * a "what am I about to lose" view.
   */
  async findUntouched(
    session: RlsSession,
    asOf: string,
    thresholdHours: number = UNTOUCHED_ALERT_HOURS,
  ): Promise<readonly UntouchedLead[]> {
    return withRlsContext(this.pool, session, async (client) => {
      const { rows } = await client.query<{
        lead_id: string;
        customer_name: string | null;
        assigned_to: string;
        rep_name: string;
        hours: string;
      }>(
        `SELECT l.lead_id, c.full_name AS customer_name, l.assigned_to,
                e.full_name AS rep_name,
                floor(extract(epoch FROM ($1::timestamptz - l.assigned_at)) / 3600)::text AS hours
           FROM lead l
           JOIN customer c ON c.customer_id = l.customer_id
           JOIN employee e ON e.employee_id = l.assigned_to
          WHERE ${untouchedPredicate('l')}
            AND l.assigned_at <= $1::timestamptz - make_interval(hours => $2::int)
          ORDER BY l.assigned_at`,
        [asOf, thresholdHours],
      );
      return rows.map((r) => ({
        leadId: r.lead_id,
        customerName: r.customer_name,
        assignedTo: r.assigned_to,
        repName: r.rep_name,
        hoursUntouched: Number(r.hours),
      }));
    });
  }

  /**
   * Return untouched leads to the pool.
   *
   * `assigned_to = NULL` IS the pool (D-76) — there is no separate flag to set, so
   * the recall is one UPDATE and cannot half-happen.
   *
   * Runs under an admin context. A rep must never be able to trigger this: it
   * would let her clear her own list of leads she had not worked, which is exactly
   * backwards.
   */
  async recallUntouched(
    session: RlsSession,
    asOf: string,
    thresholdHours: number = UNTOUCHED_RECALL_HOURS,
  ): Promise<RecallResult> {
    return withRlsContext(this.pool, session, async (client) => {
      const recalled = await this.recall(client, session, asOf, thresholdHours);
      return { asOf, recalled: recalled.length, leads: recalled };
    });
  }

  private async recall(
    client: PoolClient,
    session: RlsSession,
    asOf: string,
    thresholdHours: number,
  ): Promise<{ leadId: string; fromRep: string }[]> {
    const { rows } = await client.query<{ lead_id: string; from_rep: string }>(
      `UPDATE lead l
          SET assigned_to = NULL,
              assigned_at = NULL,
              updated_at = now()
         FROM (
           SELECT lead_id, assigned_to
             FROM lead l2
            WHERE ${untouchedPredicate('l2')}
              AND l2.assigned_at <= $1::timestamptz - make_interval(hours => $2::int)
              FOR UPDATE
         ) due
        WHERE l.lead_id = due.lead_id
    RETURNING l.lead_id, due.assigned_to AS from_rep`,
      [asOf, thresholdHours],
    );

    // The RECALL row is the point of the exercise. A lead that silently changes
    // hands is indistinguishable from one an admin moved, and "why did this leave
    // my list?" must have an answer that does not depend on anyone remembering.
    for (const row of rows) {
      await client.query(
        `INSERT INTO lead_assignment (lead_id, from_employee_id, to_employee_id,
                                      assigned_by, method, reason)
         VALUES ($1, $2, NULL, $3, 'RECALL', $4)`,
        [
          row.lead_id,
          row.from_rep,
          session.userId,
          `Returned to the pool: no contact recorded within ${thresholdHours} hours of assignment.`,
        ],
      );
    }

    return rows.map((r) => ({ leadId: r.lead_id, fromRep: r.from_rep }));
  }
}

/**
 * Assigned, still live, and no activity since it was assigned.
 *
 * Written once and shared by the alert and the recall deliberately. If the two
 * drifted, the 48h warning would name a different set of leads than the 72h
 * recall took — an admin would be told about one lead and lose another.
 *
 * Parameterised by table alias rather than string-replaced into shape. The first
 * version did `.replace(/l\./g, 'l2.')`, which works right up until a column
 * or a bound value contains the letters it matches on — a silent mis-scope in the
 * predicate that decides whose leads get taken away.
 */
const untouchedPredicate = (alias: string): string => `
  ${alias}.assigned_to IS NOT NULL
  AND ${alias}.assigned_at IS NOT NULL
  AND NOT ${alias}.is_converted
  AND ${alias}.closed_at IS NULL
  AND NOT EXISTS (
    SELECT 1 FROM activity a
     WHERE a.lead_id = ${alias}.lead_id AND a.occurred_at >= ${alias}.assigned_at
  )`;
