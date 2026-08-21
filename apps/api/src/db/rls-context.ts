import type { Pool, PoolClient } from 'pg';

/**
 * The isolation mechanism (ADR-001, D-08). Every request that touches a
 * customer-facing table runs inside one transaction that establishes who is
 * asking, before any query runs.
 *
 * If a developer forgets a WHERE clause, Postgres returns zero rows instead of
 * another rep's data. That is the entire point, and it is why this file is short
 * and boring on purpose.
 */

export type AppRole = 'OWNER' | 'ADMIN' | 'EMPLOYEE';

export interface RlsSession {
  /** app_user.user_id — NOT employee.employee_id. Conflating them was defect N1. */
  readonly userId: string;
  readonly role: AppRole;
}

/** The database role the application runs as. Owns nothing (D-21). */
export const APP_ROLE = 'app_role';

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const ROLES: readonly AppRole[] = ['OWNER', 'ADMIN', 'EMPLOYEE'];

/**
 * Establish the RLS context on an open transaction.
 *
 * Three things worth not "simplifying":
 *
 * 1. `SET LOCAL ROLE app_role` — belt and braces. Postgres table owners bypass
 *    RLS, so if DATABASE_URL_APP were ever misconfigured to the migration user,
 *    every policy would silently stop applying. Switching role inside the
 *    transaction means the query runs as app_role regardless, and app_role owns
 *    nothing. A misconfiguration becomes a permissions error, not a data leak.
 *
 * 2. `set_config(..., true)` rather than `SET LOCAL app.user_id = '<value>'`.
 *    SET LOCAL does not take bind parameters, so the literal form would mean
 *    interpolating a value into SQL on the authentication path. set_config is the
 *    parameterised equivalent, and the `true` makes it transaction-scoped.
 *
 * 3. Validation before the query. A malformed userId reaching set_config would
 *    make `current_employee_id()` return NULL, and a NULL comparison in a policy
 *    is false — which fails closed, but silently. Better to reject it loudly.
 */
export async function applyRlsContext(client: PoolClient, session: RlsSession): Promise<void> {
  if (!UUID_RE.test(session.userId)) {
    throw new Error('RLS context refused: userId is not a UUID');
  }
  if (!ROLES.includes(session.role)) {
    throw new Error(`RLS context refused: unknown role "${session.role}"`);
  }

  await client.query(`SET LOCAL ROLE ${APP_ROLE}`);
  await client.query(`SELECT set_config('app.user_id', $1, true)`, [session.userId]);
  await client.query(`SELECT set_config('app.user_role', $1, true)`, [session.role]);
}

/**
 * Run `fn` inside a transaction carrying the caller's RLS context.
 *
 * There is no way to obtain a client from this module without a session, which is
 * deliberate: an un-scoped query should be awkward to write, not one import away.
 */
export async function withRlsContext<T>(
  pool: Pool,
  session: RlsSession,
  fn: (client: PoolClient) => Promise<T>,
): Promise<T> {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await applyRlsContext(client, session);
    const result = await fn(client);
    await client.query('COMMIT');
    return result;
  } catch (e) {
    await client.query('ROLLBACK').catch(() => undefined);
    throw e;
  } finally {
    // RESET ROLE before returning to the pool. SET LOCAL unwinds with the
    // transaction, but a pooled connection that leaked a role would be a very
    // hard bug to find.
    await client.query('RESET ROLE').catch(() => undefined);
    client.release();
  }
}

/**
 * Escape hatch for work with no authenticated user: the seed loader, the ingestion
 * worker committing a batch, the nightly scoring job.
 *
 * Named to be conspicuous in a diff. Anything reachable from an HTTP request must
 * use withRlsContext instead.
 */
export async function withSystemContext<T>(
  pool: Pool,
  reason: string,
  fn: (client: PoolClient) => Promise<T>,
): Promise<T> {
  if (!reason.trim()) throw new Error('withSystemContext requires a reason, for the audit trail');
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const result = await fn(client);
    await client.query('COMMIT');
    return result;
  } catch (e) {
    await client.query('ROLLBACK').catch(() => undefined);
    throw e;
  } finally {
    client.release();
  }
}
