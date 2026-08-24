import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import pg from 'pg';
import { SYSTEM_ACTOR_EMAIL } from '@razorveda/shared';

/**
 * THE JOBS THAT NOW RUN, AND THE IDENTITY THEY RUN AS.
 *
 * Four pieces of automation were built, tested and never scheduled — rule 6's 72h
 * pool return, the repeat queue, the daily digests, and the materialised-view
 * refresh. The rules themselves are already covered by their own suites. What was
 * never covered, because it did not exist, is the machinery around them:
 *
 *   - can the refresh actually run as the application, given app_role owns nothing?
 *   - does granting that break the isolation the matviews were REVOKEd for?
 *   - is the system actor genuinely unable to log in?
 *   - can it be mistaken for an employee anywhere?
 *
 * Every one of those is a way for this change to be quietly wrong: the automation
 * appears to work while opening a hole, or appears to work while doing nothing.
 */

const DATABASE_URL = process.env['DATABASE_URL'];

let pool: pg.Pool;

beforeAll(() => {
  if (!DATABASE_URL) {
    throw new Error('DATABASE_URL is not set. These tests require a live database and will not skip.');
  }
  pool = new pg.Pool({ connectionString: DATABASE_URL });
});

afterAll(async () => {
  await pool?.end();
});

/** Runs as the application role, with the given identity. Nothing here may use the owner. */
async function asApp<T>(
  userId: string,
  role: string,
  fn: (c: pg.PoolClient) => Promise<T>,
): Promise<T> {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await client.query('SET LOCAL ROLE app_role');
    await client.query(`SELECT set_config('app.user_id', $1, true)`, [userId]);
    await client.query(`SELECT set_config('app.user_role', $1, true)`, [role]);
    return await fn(client);
  } finally {
    await client.query('ROLLBACK').catch(() => undefined);
    client.release();
  }
}

async function systemActor(): Promise<{ user_id: string; role: string; is_locked: boolean }> {
  const { rows } = await pool.query('SELECT user_id, role, is_locked FROM auth_lookup($1)', [SYSTEM_ACTOR_EMAIL]);
  const actor = rows[0];
  if (!actor) throw new Error(`${SYSTEM_ACTOR_EMAIL} is not seeded — run npm run db:seed`);
  return actor;
}

describe('the scheduled-jobs actor', () => {
  it('exists, is an admin, and is reachable through auth_lookup rather than a direct read', async () => {
    // Reachability matters as much as existence. app_user is admin-only under RLS,
    // so a plain SELECT from the API pool returns nothing — which reads as "the
    // actor is missing" and is the same trap that made every password look wrong.
    const actor = await systemActor();
    expect(actor.role).toBe('ADMIN');
    expect(actor.user_id).toMatch(/^[0-9a-f-]{36}$/);
  });

  it('is LOCKED, so it can never authenticate', async () => {
    const actor = await systemActor();
    expect(
      actor.is_locked,
      'The scheduled-jobs actor is unlocked. It has ADMIN rights and no human owner; ' +
        'an unlocked admin account nobody is responsible for is exactly what an attacker wants.',
    ).toBe(true);
  });

  it('has NO employee row, so it cannot hold a lead, a target or an incentive', async () => {
    const actor = await systemActor();
    const { rows } = await pool.query('SELECT count(*)::int AS n FROM employee WHERE user_id = $1', [actor.user_id]);
    expect(
      rows[0].n,
      'The actor has an employee row. It would then appear in the roster, could be ' +
        'assigned leads, would carry a monthly target and would show up in every ' +
        'score and incentive report as a person who never made a call.',
    ).toBe(0);
  });

  it('does not appear in the roster or in any score report', async () => {
    // Belt and braces on the previous test, from the direction a report would see
    // it: nothing that joins employee should ever surface this account.
    const { rows } = await pool.query(
      `SELECT count(*)::int AS n
         FROM employee e JOIN app_user u ON u.user_id = e.user_id
        WHERE u.email = $1`,
      [SYSTEM_ACTOR_EMAIL],
    );
    expect(rows[0].n).toBe(0);
  });
});

/**
 * A FULL REFRESH IS GENUINELY SLOW, so these get their own timeout.
 *
 * Measured on the client's volume — 180,000 orders, 996,000 status events — a
 * cold refresh of all six materialised views takes about twenty seconds, then
 * around six when warm (D-263). The suite default of 30s is fine for everything
 * else here and too tight for two tests that each rebuild every certified view.
 *
 * Raised rather than mocked: what is being tested is that `app_role` can really
 * execute this against a real database, and a faster fake would test nothing.
 */
describe('refresh_certified_views()', { timeout: 180_000 }, () => {
  it('the application role can execute it, even though it owns nothing', async () => {
    // This is the whole point. REFRESH MATERIALIZED VIEW needs ownership; app_role
    // has none by design (D-21). Without the SECURITY DEFINER doorway the refresh
    // could only run by giving the API migrator credentials.
    const actor = await systemActor();
    const rows = await asApp(actor.user_id, 'ADMIN', async (c) => {
      const r = await c.query('SELECT view_name, ran_concurrently, ms FROM refresh_certified_views()');
      return r.rows;
    });

    expect(rows.length, 'refreshed nothing — views.sql has not been applied').toBeGreaterThanOrEqual(6);
    for (const row of rows) {
      expect(row.view_name).toMatch(/^mv_/);
      expect(Number(row.ms)).toBeGreaterThanOrEqual(0);
    }
  });

  it('refreshes every view CONCURRENTLY, so readers are never blocked', async () => {
    const actor = await systemActor();
    const rows = await asApp(actor.user_id, 'ADMIN', async (c) =>
      (await c.query('SELECT view_name, ran_concurrently FROM refresh_certified_views()')).rows,
    );

    const blocking = rows.filter((r) => !r.ran_concurrently).map((r) => r.view_name);
    expect(
      blocking,
      'These refresh with an ACCESS EXCLUSIVE lock, blocking every report that reads ' +
        'them. Each needs a unique index — see packages/metrics/sql/views.sql.',
    ).toEqual([]);
  });

  it('does NOT give app_role read access to the matviews it refreshes', async () => {
    // The guard that matters. The matviews are REVOKEd from app_role because they
    // hold every rep's KPIs and every customer's phone number. Being able to
    // REFRESH them must not become being able to READ them — and a SECURITY
    // DEFINER function is exactly the kind of thing that leaks a privilege sideways.
    const actor = await systemActor();
    await expect(
      asApp(actor.user_id, 'ADMIN', (c) => c.query('SELECT * FROM mv_daily_employee_kpi LIMIT 1')),
    ).rejects.toThrow(/permission denied/i);
  });

  it('is callable by an EMPLOYEE session without exposing anything', async () => {
    // A rep cannot reach the function through any route in the API, but EXECUTE is
    // granted to app_role rather than gated on is_admin(), so the honest thing is
    // to know what happens if she gets there. Refreshing a view she cannot read
    // leaks nothing: the return value is view names and timings.
    const { rows } = await pool.query(
      `SELECT u.user_id FROM app_user u JOIN employee e ON e.user_id = u.user_id
        WHERE u.role = 'EMPLOYEE' LIMIT 1`,
    );
    const rep = rows[0];
    expect(rep, 'no EMPLOYEE seeded — run npm run db:seed:dev').toBeTruthy();

    const result = await asApp(rep.user_id, 'EMPLOYEE', async (c) =>
      (await c.query('SELECT view_name FROM refresh_certified_views()')).rows,
    );
    // Names and nothing else. No row of any view is returned.
    expect(Object.keys(result[0])).toEqual(['view_name']);
  });
});

describe('the advisory lock the scheduler relies on', () => {
  it('a second holder is refused rather than made to wait', async () => {
    // pg_try_advisory_lock is the non-blocking variant, and that choice is the
    // whole safety property: during a rolling restart the second instance must
    // SKIP its tick, not queue up and run the digest again thirty seconds later.
    const key = 8_310_001;
    const first = await pool.connect();
    const second = await pool.connect();
    try {
      const a = await first.query('SELECT pg_try_advisory_lock($1) AS locked', [key]);
      expect(a.rows[0].locked).toBe(true);

      const b = await second.query('SELECT pg_try_advisory_lock($1) AS locked', [key]);
      expect(b.rows[0].locked, 'Two processes both acquired the job lock — digests would be sent twice').toBe(false);

      await first.query('SELECT pg_advisory_unlock($1)', [key]);

      const c = await second.query('SELECT pg_try_advisory_lock($1) AS locked', [key]);
      expect(c.rows[0].locked, 'the lock was never released — the next tick would skip forever').toBe(true);
      await second.query('SELECT pg_advisory_unlock($1)', [key]);
    } finally {
      first.release();
      second.release();
    }
  });
});
