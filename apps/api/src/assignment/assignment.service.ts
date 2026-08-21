import type { Pool, PoolClient } from 'pg';
import type { AssignRequest } from '@razorveda/shared';
import { withRlsContext, type RlsSession } from '../db/rls-context.js';

/**
 * Bulk assignment (docs/07 §3, tasks/phase-1 item 5).
 *
 * D-02: leads are never assigned automatically. This runs only when an admin
 * presses the button, and every assignment writes an append-only `lead_assignment`
 * row carrying the method and, where the admin proceeded past a warning, the
 * reason.
 *
 * Exit criterion 2: 200 leads in one action, 200 rows written, under 2 seconds.
 * Two decisions serve that. Both the lead update and the assignment insert are
 * SINGLE set-based statements rather than a loop of 200 round trips; and the whole
 * thing is one transaction, so a partial assignment cannot exist.
 */

/**
 * Every field is explicitly `| undefined`. Under `exactOptionalPropertyTypes` an
 * optional property does not accept an explicit `undefined`, and query strings
 * produce exactly that. Declaring it is honest about what arrives rather than
 * making every caller launder its own input.
 */
export interface PoolFilter {
  readonly sourceId?: string | undefined;
  readonly state?: string | undefined;
  readonly productLine?: string | undefined;
  /** Only leads older than this many hours. Drives "assign the ageing ones first". */
  readonly minAgeHours?: number | undefined;
}

export interface BulkAssignInput {
  readonly request: AssignRequest;
  readonly filter: PoolFilter;
  readonly toEmployeeId: string;
  /** Present when the admin proceeded past a pre-assign warning. Logged, never blocked. */
  readonly overrideReason?: string | undefined;
}

export interface BulkAssignResult {
  readonly assigned: number;
  readonly assignmentRowsWritten: number;
}

/**
 * Builds the WHERE clause for the unassigned pool.
 *
 * `assigned_to IS NULL` is not a filter the caller can drop: the absence of an
 * assignment IS the pool (docs/02), and re-assigning a lead someone is already
 * working would silently steal it. Transfers are a separate, explicit action.
 */
function poolWhere(filter: PoolFilter, params: unknown[]): string {
  const clauses = ['l.assigned_to IS NULL', 'l.is_converted = false', 'l.closed_at IS NULL'];

  if (filter.sourceId) {
    params.push(filter.sourceId);
    clauses.push(`l.source_id = $${params.length}`);
  }
  if (filter.state) {
    params.push(filter.state);
    clauses.push(`c.state = $${params.length}`);
  }
  if (filter.productLine) {
    params.push(filter.productLine);
    clauses.push(`l.product_interest = $${params.length}`);
  }
  if (filter.minAgeHours !== undefined) {
    params.push(filter.minAgeHours);
    clauses.push(`l.received_at < now() - make_interval(hours => $${params.length}::int)`);
  }
  return clauses.join(' AND ');
}

export class AssignmentService {
  constructor(private readonly pool: Pool) {}

  /**
   * Assign in one transaction. Returns the counts so the caller can assert that
   * the number of leads moved equals the number of ledger rows written — if those
   * ever diverge, the append-only history no longer explains the current state.
   */
  async bulkAssign(
    session: RlsSession,
    input: BulkAssignInput,
  ): Promise<BulkAssignResult> {
    if (session.role !== 'ADMIN' && session.role !== 'OWNER') {
      throw new Error('Only an admin can assign leads.');
    }

    return withRlsContext(this.pool, session, async (client) => {
      const leadIds = await this.resolveTargets(client, input);
      if (leadIds.length === 0) return { assigned: 0, assignmentRowsWritten: 0 };

      // One statement, not 200. `FROM unnest($1::uuid[])` keeps this a single
      // round trip regardless of batch size, which is what makes the 2-second
      // criterion comfortable rather than marginal.
      const updated = await client.query<{ lead_id: string; previous: string | null }>(
        `UPDATE lead l
            SET assigned_to = $2, assigned_at = now(), updated_at = now()
           FROM unnest($1::uuid[]) AS t(lead_id)
          WHERE l.lead_id = t.lead_id
            AND l.assigned_to IS NULL
        RETURNING l.lead_id, NULL::uuid AS previous`,
        [leadIds, input.toEmployeeId],
      );

      const movedIds = updated.rows.map((r) => r.lead_id);
      if (movedIds.length === 0) return { assigned: 0, assignmentRowsWritten: 0 };

      // APPEND ONLY. One row per lead, always — this is the record that makes a
      // past month's assignment reconstructable.
      const inserted = await client.query<{ assignment_id: string }>(
        `INSERT INTO lead_assignment (lead_id, from_employee_id, to_employee_id,
                                      assigned_by, method, reason)
         SELECT t.lead_id, NULL, $2, $3, 'BULK', $4
           FROM unnest($1::uuid[]) AS t(lead_id)
      RETURNING assignment_id`,
        [movedIds, input.toEmployeeId, session.userId, input.overrideReason ?? null],
      );

      await client.query(
        `INSERT INTO audit_log (actor_id, actor_role, action, entity_type, after_json)
         VALUES ($1, $2::user_role, 'LEAD_BULK_ASSIGN', 'lead', $3::jsonb)`,
        [
          session.userId,
          session.role,
          JSON.stringify({
            toEmployeeId: input.toEmployeeId,
            count: movedIds.length,
            mode: input.request.mode,
            overrideReason: input.overrideReason ?? null,
          }),
        ],
      );

      return { assigned: movedIds.length, assignmentRowsWritten: inserted.rowCount ?? 0 };
    });
  }

  /**
   * Which leads to move.
   *
   * In FILTER mode the filter is re-run HERE, inside the transaction, rather than
   * trusting a list the client assembled. The admin selected "all 486 in this
   * filter" some minutes ago; by commit time an ingestion batch may have added
   * more and another admin may have taken some. Re-running means the set assigned
   * is the set that exists now, and the returned count tells the admin what
   * actually happened rather than what they expected.
   */
  private async resolveTargets(client: PoolClient, input: BulkAssignInput): Promise<string[]> {
    if (input.request.mode === 'IDS') return [...input.request.leadIds];

    const params: unknown[] = [];
    const where = poolWhere(input.filter, params);
    params.push(input.request.excludeLeadIds);

    const { rows } = await client.query<{ lead_id: string }>(
      `SELECT l.lead_id
         FROM lead l
         JOIN customer c ON c.customer_id = l.customer_id
        WHERE ${where}
          AND NOT (l.lead_id = ANY($${params.length}::uuid[]))
        ORDER BY l.received_at ASC`,
      params,
    );
    return rows.map((r) => r.lead_id);
  }

  /** Count for the pool header and the "select all in filter" badge. */
  async countPool(session: RlsSession, filter: PoolFilter): Promise<number> {
    return withRlsContext(this.pool, session, async (client) => {
      const params: unknown[] = [];
      const where = poolWhere(filter, params);
      const { rows } = await client.query<{ n: string }>(
        `SELECT count(*)::text AS n FROM lead l
           JOIN customer c ON c.customer_id = l.customer_id
          WHERE ${where}`,
        params,
      );
      return Number(rows[0]?.n ?? '0');
    });
  }
}
