import { Injectable, Inject } from '@nestjs/common';
import pgLib from 'pg';
import type { Pool, PoolClient } from 'pg';
import { withRlsContext, type RlsSession } from '../db/rls-context.js';

/**
 * The repeat-purchase engine, second half (Phase 3 deliverable 5).
 *
 * "Highest-ROI automation in the build" — and it is, because the customer has
 * already bought, already received, and is about to run out. The first half runs
 * on delivery (`StatusService.scheduleRepeat`) and sets `customer.next_due_date`.
 * This turns that date into work.
 *
 * WHY THIS IS NOT A BullMQ PROCESSOR YET:
 *
 * It is a plain service so it can be called from a scheduled job, from an admin
 * action, or from a test, and behave identically. The worker currently needs Redis
 * to start, and a job that can only be exercised on a machine with Redis running
 * is a job nobody verifies. Wiring it to the `scoring` queue is a one-line call.
 *
 * IDEMPOTENCY IS THE WHOLE DESIGN:
 *
 * A daily job that runs twice, or is retried after a network blip, must not put
 * the same customer on a rep's list twice. Two guards, because one is not enough
 * when the append-only tables cannot be cleaned up afterwards:
 *
 *   1. `next_due_date` is CLEARED as part of the same statement that creates the
 *      lead, so a second run finds nothing due.
 *   2. A customer with an open, unconverted DELIVERED_REPEAT lead is skipped
 *      regardless, so a manual re-run or a clock change cannot double-book her.
 */

export interface RepeatRunResult {
  readonly asOf: string;
  readonly leadsCreated: number;
  readonly skippedAlreadyOpen: number;
  readonly skippedNoOwner: number;
}

@Injectable()
export class RepeatService {
  constructor(@Inject(pgLib.Pool) private readonly pool: Pool) {}

  /**
   * Runs under an ADMIN context, and that is not incidental.
   *
   * The first version of this took no session and opened a raw connection,
   * carrying a comment claiming it ran as the migrator role and bypassed RLS. It
   * did not: the API pool connects as `razorveda_app`, so every query ran under
   * RLS with no `app.user_id` set, matched nothing, and the job reported
   * `leadsCreated: 0` — cheerfully, with `ok: true`, having scanned an empty
   * view of the customer table.
   *
   * The same shape as the two-factor enrolment bug and the three before it: RLS
   * refuses silently, and the caller reads the emptiness as a fact about the
   * business rather than about its own permissions. A comment asserting the
   * opposite is worse than no comment, because it stops the next person checking.
   *
   * The job spans every rep's customers by design, so it needs a context that can
   * see them: an admin's. A nightly run passes the system admin's session.
   */
  async materialiseDue(session: RlsSession, asOf: string): Promise<RepeatRunResult> {
    return withRlsContext(this.pool, session, (client) => this.run(client, asOf));
  }

  private async run(client: PoolClient, asOf: string): Promise<RepeatRunResult> {
    // Counted before the work, so the report distinguishes "nothing was due" from
    // "everything due was skipped" — two very different mornings for an admin.
    const { rows: [pending] } = await client.query<{ open: string; no_owner: string }>(
      `SELECT
         count(*) FILTER (WHERE EXISTS (
           SELECT 1 FROM lead l JOIN lead_source s ON s.source_id = l.source_id
            WHERE l.customer_id = c.customer_id AND s.code = 'DELIVERED_REPEAT'
              AND l.closed_at IS NULL AND NOT l.is_converted
         ))::text AS open,
         count(*) FILTER (WHERE c.owner_employee_id IS NULL)::text AS no_owner
       FROM customer c
      WHERE c.next_due_date IS NOT NULL AND c.next_due_date <= $1::date
        AND NOT c.do_not_call`,
      [asOf],
    );

    const { rows } = await client.query<{ lead_id: string; owner: string }>(
      `WITH due AS (
         SELECT c.customer_id, c.owner_employee_id
           FROM customer c
          WHERE c.next_due_date IS NOT NULL
            AND c.next_due_date <= $1::date
            -- do_not_call is not advisory. A customer who has asked not to be
            -- contacted does not re-enter a worklist because an algorithm thinks
            -- she is due.
            AND NOT c.do_not_call
            AND c.owner_employee_id IS NOT NULL
            AND NOT EXISTS (
              SELECT 1 FROM lead l JOIN lead_source s ON s.source_id = l.source_id
               WHERE l.customer_id = c.customer_id AND s.code = 'DELIVERED_REPEAT'
                 AND l.closed_at IS NULL AND NOT l.is_converted
            )
          FOR UPDATE
       ), cleared AS (
         -- Cleared in the same statement that creates the lead. If this were a
         -- separate UPDATE, a crash between the two would leave the customer due
         -- forever and she would be added to the list again every night.
         UPDATE customer SET next_due_date = NULL, updated_at = now()
          WHERE customer_id IN (SELECT customer_id FROM due)
       )
       INSERT INTO lead (customer_id, source_id, assigned_to, assigned_at, received_at,
                         valid_till, temperature)
       SELECT d.customer_id, s.source_id, d.owner_employee_id, now(), now(),
              (CURRENT_DATE + s.validity_days)::date, 'WARM'::lead_temperature
         FROM due d, lead_source s
        WHERE s.code = 'DELIVERED_REPEAT'
    RETURNING lead_id, assigned_to AS owner`,
      [asOf],
    );

    // Every assignment gets a row, including this one. An append-only ledger that
    // the system quietly writes around is not an audit trail — an admin asking
    // "why is this on Nikita's list?" must get an answer from the same table that
    // answers it for a manual assignment.
    for (const row of rows) {
      await client.query(
        `INSERT INTO lead_assignment (lead_id, from_employee_id, to_employee_id, method, reason)
         VALUES ($1, NULL, $2, 'SYSTEM', $3)`,
        [
          row.lead_id,
          row.owner,
          'Repeat purchase due: this rep owns the customer relationship from the delivered order.',
        ],
      );
    }

    return {
      asOf,
      leadsCreated: rows.length,
      skippedAlreadyOpen: Number(pending?.open ?? '0'),
      skippedNoOwner: Number(pending?.no_owner ?? '0'),
    };
  }
}
