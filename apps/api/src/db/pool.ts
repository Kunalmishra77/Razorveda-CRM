import pg from 'pg';

/**
 * The application connection pool.
 *
 * Uses DATABASE_URL_APP — the role that owns NOTHING (D-21). Connecting as the
 * migration user would silently disable every RLS policy in the system while
 * leaving all eight isolation tests green, because those tests SET ROLE
 * explicitly. That is the single worst failure mode this codebase has, so the
 * variable is separate and the reason is written where someone will read it.
 */
export function createAppPool(): pg.Pool {
  const connectionString = process.env['DATABASE_URL_APP'];
  if (!connectionString) {
    throw new Error(
      'DATABASE_URL_APP is not set. The API must connect as a role that owns no ' +
        'tables (D-21) — see .env.example. Do NOT fall back to DATABASE_URL: that ' +
        'is the migration user, which owns the tables and therefore bypasses RLS.',
    );
  }
  return new pg.Pool({ connectionString, max: 10, idleTimeoutMillis: 30_000 });
}
