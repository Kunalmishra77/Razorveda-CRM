import type { Pool } from 'pg';
import { withRlsContext, type RlsSession } from '../db/rls-context.js';

/**
 * MOVING WORK THAT IS ALREADY SOMEBODY'S.
 *
 * `assignment.service.ts` deliberately refuses to touch an assigned lead: the
 * absence of an assignment IS the pool, and reassigning a lead someone is working
 * would silently steal it. Its comment says transfers are "a separate, explicit
 * action" — this is that action, and until now it did not exist. The client asked
 * for it in as many words: an admin must be able to *reassign, split and move*
 * data, because a rep goes on leave, a rep leaves, a rep is drowning while
 * another has nothing, and a lead lands with the wrong person.
 *
 * The whole file turns on one distinction. Assigning from the pool takes nothing
 * away from anyone. A transfer does. So:
 *
 *   - A REASON IS MANDATORY, not optional as it is on a bulk assign. Somebody
 *     will ask "why did my lead go to Divya" three weeks from now — most likely
 *     the rep who lost it, and most likely because her incentive moved with it.
 *     An append-only ledger that cannot answer that question is decoration.
 *
 *   - THE `from` REP IS PART OF THE PREDICATE, never just a label. The admin
 *     picked these leads off a screen rendered some seconds ago; by the time she
 *     presses the button another admin may have moved one, or the 72-hour recall
 *     may have pulled it back to the pool. `assigned_to = $from` in the WHERE
 *     means a lead that has since moved is not moved again, and the response
 *     reports what actually happened rather than what was asked for.
 *
 *   - `assigned_at` IS RESET on the receiving rep. It drives the 48-hour alert
 *     and the 72-hour return-to-pool, and inheriting the previous rep's clock
 *     would hand someone a lead that is already late — occasionally one that is
 *     recalled out from under her before she has seen it.
 *
 * Nothing here decides anything. No lead moves without an admin pressing the
 * button, and no rule in this file picks who receives it (CLAUDE.md rule 6).
 */

export type TransferDestination = { readonly kind: 'REP'; readonly toEmployeeId: string } | { readonly kind: 'POOL' };

export interface TransferInput {
  readonly leadIds: readonly string[];
  readonly fromEmployeeId: string;
  readonly to: TransferDestination;
  /** Mandatory. See the header — this is the answer to "why did I lose that lead". */
  readonly reason: string;
}

export interface TransferResult {
  readonly moved: number;
  readonly assignmentRowsWritten: number;
  /** Asked for but not moved: already elsewhere, closed, or converted. */
  readonly skipped: number;
}

export class TransferService {
  constructor(private readonly pool: Pool) {}

  async transfer(session: RlsSession, input: TransferInput): Promise<TransferResult> {
    if (session.role !== 'ADMIN' && session.role !== 'OWNER') {
      throw new Error('Only an admin can move a lead that is already assigned.');
    }
    const reason = input.reason.trim();
    if (reason.length === 0) {
      throw new Error('A reason is required to move work off a rep.');
    }
    const asked = input.leadIds.length;
    if (asked === 0) return { moved: 0, assignmentRowsWritten: 0, skipped: 0 };

    const toId = input.to.kind === 'REP' ? input.to.toEmployeeId : null;
    if (toId !== null && toId === input.fromEmployeeId) {
      throw new Error('That is the rep who already holds these leads. Choose a different one.');
    }

    return withRlsContext(this.pool, session, async (client) => {
      // One set-based statement, not a loop — same reason bulkAssign is written
      // this way: 200 leads in one action has to stay one round trip.
      //
      // A lead that is converted or closed is left alone. Moving a delivered
      // customer's lead to a new rep would put a name on her worklist that has
      // nothing left to do, and the attribution ledger has already paid out
      // against the rep who booked it.
      const moved = await client.query<{ lead_id: string }>(
        `UPDATE lead l
            SET assigned_to = $3,
                -- Reset, not inherited. See the header: this is the 48/72h clock.
                assigned_at = CASE WHEN $3::uuid IS NULL THEN NULL ELSE now() END,
                updated_at = now()
           FROM unnest($1::uuid[]) AS t(lead_id)
          WHERE l.lead_id = t.lead_id
            AND l.assigned_to = $2
            AND l.is_converted = false
            AND l.closed_at IS NULL
        RETURNING l.lead_id`,
        [input.leadIds, input.fromEmployeeId, toId],
      );

      const movedIds = moved.rows.map((r) => r.lead_id);
      if (movedIds.length === 0) {
        return { moved: 0, assignmentRowsWritten: 0, skipped: asked };
      }

      // APPEND ONLY, and `from_employee_id` is finally populated — every previous
      // writer of this table left it NULL because every previous path came from
      // the pool. This is the row that reconstructs who held what, when.
      //
      // RECALL when it goes back to the pool, TRANSFER when it goes to a person.
      // Both values have been in the enum since the schema was written and
      // neither had ever been used.
      const inserted = await client.query<{ assignment_id: string }>(
        `INSERT INTO lead_assignment (lead_id, from_employee_id, to_employee_id,
                                      assigned_by, method, reason)
         SELECT t.lead_id, $2, $3, $4,
                CASE WHEN $3::uuid IS NULL THEN 'RECALL' ELSE 'TRANSFER' END::assign_method,
                $5
           FROM unnest($1::uuid[]) AS t(lead_id)
      RETURNING assignment_id`,
        [movedIds, input.fromEmployeeId, toId, session.userId, reason],
      );

      await client.query(
        `INSERT INTO audit_log (actor_id, actor_role, action, entity_type, after_json)
         VALUES ($1, $2::user_role, $3, 'lead', $4::jsonb)`,
        [
          session.userId,
          session.role,
          toId === null ? 'LEAD_RETURN_TO_POOL' : 'LEAD_TRANSFER',
          JSON.stringify({
            fromEmployeeId: input.fromEmployeeId,
            toEmployeeId: toId,
            asked,
            moved: movedIds.length,
            reason,
          }),
        ],
      );

      return {
        moved: movedIds.length,
        assignmentRowsWritten: inserted.rowCount ?? 0,
        skipped: asked - movedIds.length,
      };
    });
  }
}
