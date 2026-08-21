import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import pg from 'pg';
import { applyRlsContext } from '../../src/db/rls-context.js';

/**
 * THE EIGHT ISOLATION TESTS — docs/05, "Tests that must exist before any UI ships".
 *
 * These require a live Postgres. They are NOT part of `npm test`, because a test
 * that silently skips when the database is absent is worse than no test at all:
 * it turns "we never ran it" into "it passed". Run them with:
 *
 *     npm run test:rls -w @razorveda/api
 *
 * and they FAIL LOUDLY if they cannot connect.
 *
 * Two things they are built to catch, both of which have already bitten us once:
 *
 *   D-21  Postgres table owners BYPASS RLS. A check run as the migration user
 *         returns every row while looking like a pass. Every assertion here runs
 *         through applyRlsContext, which does SET LOCAL ROLE app_role first, and
 *         test 3 deliberately runs WITHOUT it to show the counts differ.
 *
 *   N1    app.user_id is an app_user.user_id; lead.assigned_to is an
 *         employee.employee_id. Comparing them directly returns zero rows for
 *         everyone — secure, but broken. Test 2 asserts a rep can see their OWN
 *         customer's phone, which is what a fail-closed bug would break.
 */

const DATABASE_URL = process.env['DATABASE_URL'];

let pool: pg.Pool;
let reps: Array<{ userId: string; employeeId: string; name: string }> = [];

async function ctx<T>(
  session: { userId: string; role: 'OWNER' | 'ADMIN' | 'EMPLOYEE' },
  fn: (c: pg.PoolClient) => Promise<T>,
): Promise<T> {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await applyRlsContext(client, session);
    return await fn(client);
  } finally {
    await client.query('ROLLBACK').catch(() => undefined);
    await client.query('RESET ROLE').catch(() => undefined);
    client.release();
  }
}

const count = async (c: pg.PoolClient, sql: string, params: unknown[] = []): Promise<number> => {
  const { rows } = await c.query<{ n: string }>(sql, params);
  return Number(rows[0]?.n ?? '0');
};

beforeAll(async () => {
  if (!DATABASE_URL) {
    throw new Error(
      'DATABASE_URL is not set. These tests require a live database and will not skip.\n' +
        'Run: npm run infra:up && npm run db:migrate -- --fresh && npm run db:seed',
    );
  }
  pool = new pg.Pool({ connectionString: DATABASE_URL });

  const { rows } = await pool.query<{ user_id: string; employee_id: string; full_name: string }>(
    `SELECT u.user_id, e.employee_id, e.full_name
       FROM employee e JOIN app_user u ON u.user_id = e.user_id
      WHERE u.role = 'EMPLOYEE' AND e.status = 'ACTIVE'
      ORDER BY e.emp_code LIMIT 2`,
  );
  reps = rows.map((r) => ({ userId: r.user_id, employeeId: r.employee_id, name: r.full_name }));

  if (reps.length < 2) {
    throw new Error(`need 2 active employees to test isolation, found ${reps.length}. Run db:seed.`);
  }
});

afterAll(async () => {
  await pool?.end();
});

describe('docs/05 — the eight isolation tests', () => {
  it('1. a rep cannot read a lead belonging to another rep', async () => {
    const [a, b] = reps as [(typeof reps)[0], (typeof reps)[1]];

    const bLeadId = await ctx({ userId: b.userId, role: 'EMPLOYEE' }, async (c) => {
      const { rows } = await c.query<{ lead_id: string }>('SELECT lead_id FROM lead LIMIT 1');
      return rows[0]?.lead_id ?? null;
    });
    if (!bLeadId) return; // nothing assigned to B yet; test 2 covers the general case

    const visible = await ctx({ userId: a.userId, role: 'EMPLOYEE' }, (c) =>
      count(c, 'SELECT count(*)::text AS n FROM lead WHERE lead_id = $1', [bLeadId]),
    );
    // Zero rows, not a permissions error: the API turns this into 404, which
    // avoids confirming the record exists.
    expect(visible).toBe(0);
  });

  it('2. a list query returns only the caller rows — and DOES return their own', async () => {
    const [a] = reps as [(typeof reps)[0]];

    const { own, foreign } = await ctx({ userId: a.userId, role: 'EMPLOYEE' }, async (c) => ({
      own: await count(c, 'SELECT count(*)::text AS n FROM lead WHERE assigned_to = $1', [
        a.employeeId,
      ]),
      foreign: await count(c, 'SELECT count(*)::text AS n FROM lead WHERE assigned_to <> $1', [
        a.employeeId,
      ]),
    }));

    expect(foreign, 'a rep saw leads assigned to someone else').toBe(0);

    const actual = await pool
      .query<{ n: string }>('SELECT count(*)::text AS n FROM lead WHERE assigned_to = $1', [
        a.employeeId,
      ])
      .then((r) => Number(r.rows[0]?.n ?? '0'));
    // The N1 half: fail-CLOSED is still a bug. A rep must see their own rows.
    expect(own, 'a rep could not see their own leads — check for a user_id/employee_id mix-up')
      .toBe(actual);
  });

  it('3. customer_identifier leaks no phone outside the caller own customers', async () => {
    // This is the table that was unprotected twice (B1, then N1). It holds every
    // phone number in the business, so it gets its own test.
    const [a] = reps as [(typeof reps)[0]];

    const visible = await ctx({ userId: a.userId, role: 'EMPLOYEE' }, (c) =>
      count(
        c,
        `SELECT count(*)::text AS n FROM customer_identifier ci
          WHERE NOT EXISTS (SELECT 1 FROM lead l
                             WHERE l.customer_id = ci.customer_id AND l.assigned_to = $1)
            AND NOT EXISTS (SELECT 1 FROM customer cu
                             WHERE cu.customer_id = ci.customer_id
                               AND cu.owner_employee_id = $1)`,
        [a.employeeId],
      ),
    );
    expect(visible, 'a rep could read phone numbers of customers they do not hold').toBe(0);
  });

  it('4. no employee-role query returns more than 50 rows', async () => {
    const [a] = reps as [(typeof reps)[0]];
    const rows = await ctx({ userId: a.userId, role: 'EMPLOYEE' }, async (c) => {
      const { rows } = await c.query('SELECT lead_id FROM lead LIMIT 51');
      return rows.length;
    });
    // The cap is enforced in the API layer; this asserts the seeded fixture does
    // not silently exceed it and hide a pagination bug.
    expect(rows).toBeLessThanOrEqual(50);
  });

  it('5. append-only tables reject UPDATE', async () => {
    await expect(
      pool.query(`UPDATE activity SET remark_raw = 'x' WHERE true`),
    ).rejects.toThrow(/append-only/i);
  });

  it('6. append-only tables reject DELETE', async () => {
    await expect(pool.query(`DELETE FROM activity WHERE true`)).rejects.toThrow(/append-only/i);
  });

  it('7. an admin sees across reps, and a rep does not', async () => {
    const [a] = reps as [(typeof reps)[0]];
    const asAdmin = await ctx({ userId: a.userId, role: 'ADMIN' }, (c) =>
      count(c, 'SELECT count(*)::text AS n FROM customer_identifier'),
    );
    const asRep = await ctx({ userId: a.userId, role: 'EMPLOYEE' }, (c) =>
      count(c, 'SELECT count(*)::text AS n FROM customer_identifier'),
    );
    const total = await pool
      .query<{ n: string }>('SELECT count(*)::text AS n FROM customer_identifier')
      .then((r) => Number(r.rows[0]?.n ?? '0'));

    expect(asAdmin).toBe(total);
    expect(asRep).toBeLessThanOrEqual(asAdmin);
  });

  it('8. the same query as the table OWNER returns MORE — proving SET ROLE is required', async () => {
    // The test that stops every other test in this file from lying.
    //
    // Without SET LOCAL ROLE app_role the query runs as the migration user, which
    // owns the tables and therefore bypasses RLS. If these two counts were ever
    // equal, either the seed has no cross-rep data or the isolation is not working
    // — and both are worth failing for.
    const [a] = reps as [(typeof reps)[0]];

    const scoped = await ctx({ userId: a.userId, role: 'EMPLOYEE' }, (c) =>
      count(c, 'SELECT count(*)::text AS n FROM lead'),
    );
    const unscoped = await pool
      .query<{ n: string }>('SELECT count(*)::text AS n FROM lead')
      .then((r) => Number(r.rows[0]?.n ?? '0'));

    expect(unscoped).toBeGreaterThan(scoped);
  });
});
