import type { Pool } from 'pg';

/**
 * Refreshes the certified materialised views.
 *
 * WHY THIS DID NOT EXIST, AND WHAT THAT MEANT.
 *
 * docs/04: reports read certified views and nothing else. Six of those views are
 * MATERIALISED, so each holds a snapshot from its last refresh — and nothing in
 * this system ever refreshed them. The only REFRESH statement anywhere was inside
 * the restore drill.
 *
 * Every KPI, funnel, product-revenue, geography, RTO and repeat-queue figure was
 * therefore frozen at the moment the database was migrated. Not wrong — STALE, in
 * the way that is hardest to spot: the numbers stay internally consistent and
 * simply describe an earlier day. A rep's dashboard would show a plausible
 * yesterday forever, and no test would fail.
 *
 * THE WORK HAPPENS IN THE DATABASE, and it has to.
 *
 * REFRESH MATERIALIZED VIEW requires ownership of the view. `app_role` owns
 * nothing (D-21) and the matviews are REVOKEd from it outright, which is what
 * stops a rep reading a colleague's KPIs. So this cannot be a query the API
 * issues; it is a call to `refresh_certified_views()`, one narrow SECURITY DEFINER
 * doorway that may refresh the certified views and do nothing else.
 *
 * The rejected alternative was giving the API process migrator credentials — DDL
 * rights over the entire schema, held by a web-facing service, to run a
 * maintenance statement.
 */

export interface RefreshOutcome {
  readonly view: string;
  readonly concurrent: boolean;
  readonly ms: number;
}

export interface RefreshMetricsResult {
  readonly refreshed: readonly RefreshOutcome[];
  readonly totalMs: number;
}

export async function refreshMetrics(pool: Pool): Promise<RefreshMetricsResult> {
  const started = Date.now();

  const { rows } = await pool.query<{ view_name: string; ran_concurrently: boolean; ms: number }>(
    'SELECT view_name, ran_concurrently, ms FROM refresh_certified_views()',
  );

  // Zero views is a misconfiguration, not a quiet success. It means views.sql was
  // never applied or this is pointing at the wrong database, and a job that
  // reports "refreshed 0 views, all good" every fifteen minutes is exactly how
  // the original defect stayed invisible.
  if (rows.length === 0) {
    throw new Error(
      'refresh_certified_views() refreshed nothing. packages/metrics/sql/views.sql has ' +
        'not been applied to this database, so every report is reading views that do not exist.',
    );
  }

  return {
    refreshed: rows.map((r) => ({ view: r.view_name, concurrent: r.ran_concurrently, ms: Number(r.ms) })),
    totalMs: Date.now() - started,
  };
}
