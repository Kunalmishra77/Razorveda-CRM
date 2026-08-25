import type { Pool, PoolClient } from 'pg';
import { withRlsContext, type RlsSession } from '../db/rls-context.js';
import { poolWhereFor, type PoolFilter } from './assignment.service.js';

/**
 * SPLITTING ONE BATCH ACROSS SEVERAL REPS, IN ONE ACTION.
 *
 * The client's words were "reassign, split and move". Move exists now
 * (transfer.service.ts). Split did not: `bulkAssign` takes ONE `toEmployeeId`, so
 * distributing four hundred fresh leads across five reps meant five separate
 * operations, each one racing the others for the same pool, with no way to tell
 * afterwards whether the totals came out as intended. That is the morning this
 * product exists to replace.
 *
 * `suggestSplit` has been able to PROPOSE a distribution since Phase 1 and could
 * never apply one. This closes that gap and keeps D-02 intact: the proposal is a
 * starting point, the admin edits the numbers, and nothing moves until a person
 * presses the button. Nothing in this file decides who gets what.
 *
 * THREE PROPERTIES THAT MAKE A SPLIT DIFFERENT FROM N ASSIGNMENTS:
 *
 *   1. ONE TRANSACTION. A half-applied split is worse than none — two reps
 *      called the same customer and nobody can see why.
 *
 *   2. OLDEST FIRST, AND THE ORDER IS PART OF THE CONTRACT. The pool is listed
 *      oldest-first because ageing leads are the ones losing value, so a split
 *      hands them out in that order too. It also makes the result reproducible:
 *      the same pool and the same counts produce the same distribution.
 *
 *   3. THE SHORTFALL IS REPORTED. If the counts ask for more leads than the pool
 *      holds — because an admin typed them minutes ago and someone else has been
 *      assigning since — the reps are filled in the order given and the response
 *      says how many did not land. Silently assigning 380 when 400 was asked for
 *      is how a batch goes missing.
 */

export interface SplitShare {
  readonly toEmployeeId: string;
  readonly leadCount: number;
}

export interface SplitInput {
  /** Explicit ids when the admin ticked rows; otherwise the filter decides. */
  readonly leadIds?: readonly string[] | undefined;
  readonly filter: PoolFilter;
  readonly shares: readonly SplitShare[];
  readonly note?: string | undefined;
}

export interface SplitResult {
  readonly assigned: number;
  readonly assignmentRowsWritten: number;
  /** Asked for but not available — the pool ran out. */
  readonly shortfall: number;
  readonly perRep: ReadonlyArray<{ toEmployeeId: string; asked: number; got: number }>;
}

export class SplitService {
  constructor(private readonly pool: Pool) {}

  async split(session: RlsSession, input: SplitInput): Promise<SplitResult> {
    if (session.role !== 'ADMIN' && session.role !== 'OWNER') {
      throw new Error('Only an admin can assign leads.');
    }

    const shares = input.shares.filter((s) => s.leadCount > 0);
    if (shares.length === 0) {
      throw new Error('Give at least one rep a number greater than zero.');
    }
    // A rep listed twice would have her two counts applied in sequence, which is
    // not what anybody typing it meant.
    const seen = new Set<string>();
    for (const s of shares) {
      if (seen.has(s.toEmployeeId)) {
        throw new Error('The same rep appears twice. Put her whole share on one line.');
      }
      seen.add(s.toEmployeeId);
    }

    const asked = shares.reduce((a, s) => a + s.leadCount, 0);

    return withRlsContext(this.pool, session, async (client) => {
      const available = await this.resolvePool(client, input);
      const perRep: Array<{ toEmployeeId: string; asked: number; got: number }> = [];

      let cursor = 0;
      let assignedTotal = 0;
      let rowsTotal = 0;

      for (const share of shares) {
        const slice = available.slice(cursor, cursor + share.leadCount);
        cursor += slice.length;

        if (slice.length === 0) {
          perRep.push({ toEmployeeId: share.toEmployeeId, asked: share.leadCount, got: 0 });
          continue;
        }

        // Still guarded by `assigned_to IS NULL`. The set was read inside this
        // transaction, but the guard costs nothing and it is the invariant that
        // makes "assignment from the pool" mean what it says.
        const moved = await client.query<{ lead_id: string }>(
          `UPDATE lead l
              SET assigned_to = $2, assigned_at = now(), updated_at = now()
             FROM unnest($1::uuid[]) AS t(lead_id)
            WHERE l.lead_id = t.lead_id
              AND l.assigned_to IS NULL
          RETURNING l.lead_id`,
          [slice, share.toEmployeeId],
        );
        const movedIds = moved.rows.map((r) => r.lead_id);

        if (movedIds.length > 0) {
          const inserted = await client.query(
            `INSERT INTO lead_assignment (lead_id, from_employee_id, to_employee_id,
                                          assigned_by, method, reason)
             SELECT t.lead_id, NULL, $2, $3, 'BULK', $4
               FROM unnest($1::uuid[]) AS t(lead_id)`,
            [movedIds, share.toEmployeeId, session.userId, input.note ?? 'Split across the team'],
          );
          rowsTotal += inserted.rowCount ?? 0;
        }

        assignedTotal += movedIds.length;
        perRep.push({
          toEmployeeId: share.toEmployeeId,
          asked: share.leadCount,
          got: movedIds.length,
        });
      }

      await client.query(
        `INSERT INTO audit_log (actor_id, actor_role, action, entity_type, after_json)
         VALUES ($1, $2::user_role, 'LEAD_SPLIT', 'lead', $3::jsonb)`,
        [
          session.userId,
          session.role,
          JSON.stringify({
            asked,
            assigned: assignedTotal,
            shortfall: asked - assignedTotal,
            perRep,
            note: input.note ?? null,
          }),
        ],
      );

      return {
        assigned: assignedTotal,
        assignmentRowsWritten: rowsTotal,
        shortfall: asked - assignedTotal,
        perRep,
      };
    });
  }

  /**
   * The leads this split may draw on, oldest first.
   *
   * Read INSIDE the transaction rather than trusting a list assembled on the
   * client minutes ago — the same reasoning as `bulkAssign.resolveTargets`. An
   * ingestion batch may have added rows and another admin may have taken some,
   * and the counts the admin typed should be filled from what exists now.
   *
   * Explicit ids are still re-checked against the pool: a ticked row that has
   * since been assigned is dropped rather than stolen.
   */
  private async resolvePool(client: PoolClient, input: SplitInput): Promise<string[]> {
    const params: unknown[] = [];
    const where = poolWhereFor(input.filter, params);

    if (input.leadIds && input.leadIds.length > 0) {
      params.push(input.leadIds);
      const { rows } = await client.query<{ lead_id: string }>(
        `SELECT l.lead_id
           FROM lead l JOIN customer c ON c.customer_id = l.customer_id
          WHERE ${where}
            AND l.lead_id = ANY($${params.length}::uuid[])
          ORDER BY l.received_at ASC`,
        params,
      );
      return rows.map((r) => r.lead_id);
    }

    const { rows } = await client.query<{ lead_id: string }>(
      `SELECT l.lead_id
         FROM lead l JOIN customer c ON c.customer_id = l.customer_id
        WHERE ${where}
        ORDER BY l.received_at ASC`,
      params,
    );
    return rows.map((r) => r.lead_id);
  }
}
