import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import pg from 'pg';

/**
 * EVERY TABLE HAS ROW-LEVEL SECURITY. No exceptions that are not written down.
 *
 * CLAUDE.md rule 5 makes RLS the isolation mechanism: "if a developer forgets a
 * filter, the database must still return nothing." That guarantee is only as good
 * as its coverage, and coverage is exactly the thing that decays — schema.sql and
 * rls-policies.sql are separate files, and adding a table to one does not remind
 * anyone about the other.
 *
 * It has already happened once. `incentive_modifier` shipped with RLS off and no
 * policy, and nothing failed: the migration succeeded, the seed succeeded, the
 * tests passed, and the table holding the incentive scheme was readable by any
 * authenticated session. Found by auditing pg_class by hand, which is not a plan.
 *
 * `customer_identifier` was the same shape earlier in the project (§7b, item 3) —
 * it holds every phone number in the business and was missing from both the doc
 * and the SQL.
 *
 * The allowlist below is the ONLY escape, and every entry needs a reason.
 *
 * The first version of this test only asked "is there A policy?", and that was
 * too weak. `employee_score_daily` had a SELECT policy and no write policy at
 * all, so it passed while nothing in the system could write a score. A read
 * policy without its write half is the single most repeated defect in this
 * codebase — audit_log, order_status_event, attribution_ledger, app_user and
 * then this one — so coverage is now checked per COMMAND, not per table.
 */

const DATABASE_URL = process.env['DATABASE_URL'];

/** Tables that legitimately have no policy. Keep this list short and justified. */
const EXEMPT: Readonly<Record<string, string>> = {
  // Written by `migrate` before any role exists, read by the D-17 guard to prove a
  // database was built locally. Holds no business data and must be readable by the
  // migrator alone — RLS would add nothing to protect.
  _local_dev_marker: 'dev-only build marker, holds no business data',
};

let pool: pg.Pool;

beforeAll(async () => {
  if (!DATABASE_URL) {
    throw new Error('DATABASE_URL is not set. These tests require a live database and will not skip.');
  }
  pool = new pg.Pool({ connectionString: DATABASE_URL });
});

afterAll(async () => {
  await pool?.end();
});

interface TableRow {
  table_name: string;
  rls_on: boolean;
  forced: boolean;
  policies: number;
  /** pg_policy.polcmd: '*' ALL, 'r' SELECT, 'a' INSERT, 'w' UPDATE, 'd' DELETE. */
  commands: string[];
}

const tables = async (): Promise<TableRow[]> => {
  const { rows } = await pool.query<TableRow>(
    `SELECT c.relname AS table_name,
            c.relrowsecurity  AS rls_on,
            c.relforcerowsecurity AS forced,
            (SELECT count(*)::int FROM pg_policy p WHERE p.polrelid = c.oid) AS policies,
            coalesce((SELECT array_agg(DISTINCT p.polcmd::text)
                        FROM pg_policy p WHERE p.polrelid = c.oid), '{}') AS commands
       FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
      WHERE n.nspname = 'public' AND c.relkind = 'r'
      ORDER BY c.relname`,
  );
  return rows;
};

describe('RLS coverage', () => {
  it('finds a realistic number of tables, so the test cannot pass vacuously', async () => {
    // Guard the guard. If the query broke or pointed at an empty schema, every
    // assertion below would pass over nothing.
    expect((await tables()).length).toBeGreaterThan(25);
  });

  it('every table has row-level security ENABLED', async () => {
    const missing = (await tables())
      .filter((t) => !t.rls_on && !(t.table_name in EXEMPT))
      .map((t) => t.table_name);
    expect(missing).toEqual([]);
  });

  it('every table has row-level security FORCED, so the owner cannot bypass it', async () => {
    // D-21: table owners bypass RLS unless it is FORCED. Without this, a policy
    // exists and simply does not apply to the role that runs migrations — and any
    // check run as that role reports a pass while proving nothing.
    const unforced = (await tables())
      .filter((t) => t.rls_on && !t.forced && !(t.table_name in EXEMPT))
      .map((t) => t.table_name);
    expect(unforced).toEqual([]);
  });

  it('every table with RLS enabled actually carries a policy', async () => {
    // RLS enabled with zero policies denies everything, which fails safe but
    // breaks the app silently. Both halves have to be present.
    const policyless = (await tables())
      .filter((t) => t.rls_on && t.policies === 0 && !(t.table_name in EXEMPT))
      .map((t) => t.table_name);
    expect(policyless).toEqual([]);
  });

  it('every table can be WRITTEN, not just read', async () => {
    // The check that would have caught employee_score_daily. A SELECT-only policy
    // set denies every insert, which fails safe and also means the feature simply
    // does not work — discovered at runtime, in the one case that raises, and
    // silently in the several that do not.
    const readOnly = (await tables())
      .filter((t) => t.rls_on && !(t.table_name in EXEMPT))
      .filter((t) => !t.commands.includes('*') && !t.commands.includes('a'))
      .map((t) => t.table_name);
    expect(readOnly).toEqual([]);
  });

  it('every table can be READ, so a policy set is never write-only', async () => {
    const writeOnly = (await tables())
      .filter((t) => t.rls_on && !(t.table_name in EXEMPT))
      .filter((t) => !t.commands.includes('*') && !t.commands.includes('r'))
      .map((t) => t.table_name);
    expect(writeOnly).toEqual([]);
  });

  it('every exemption is still a real table, so the list cannot rot', async () => {
    // An allowlist entry for a table that no longer exists is dead weight that
    // makes the next reader trust the list less.
    const names = new Set((await tables()).map((t) => t.table_name));
    for (const exempt of Object.keys(EXEMPT)) {
      expect(names.has(exempt), `${exempt} is exempted but does not exist`).toBe(true);
    }
  });
});

/**
 * MATERIALISED VIEWS ARE A HOLE IN THE MODEL, AND THIS IS THE PATCH.
 *
 * Postgres allows an RLS policy only on a TABLE. A matview carries none, and the
 * checks above never saw them because they filter `relkind = 'r'`. Meanwhile
 * `ALTER DEFAULT PRIVILEGES` (D-27) grants app_role SELECT on everything new by
 * design — including, the moment they were created, six matviews holding every
 * rep's KPIs, the full RTO analysis, and every customer phone number in the
 * repeat-due queue.
 *
 * Nothing failed. The isolation tests passed, the policy-coverage tests passed,
 * and a rep could have read the lot with one query.
 *
 * The rule: app_role never touches a matview directly. It reads a
 * security_barrier view that applies the predicate the matview cannot.
 */
describe('materialised views are not a bypass', () => {
  const matviews = async (): Promise<{ name: string; app_can_read: boolean }[]> => {
    const { rows } = await pool.query<{ name: string; app_can_read: boolean }>(
      `SELECT c.relname AS name,
              has_table_privilege('app_role', c.oid, 'SELECT') AS app_can_read
         FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
        WHERE n.nspname = 'public' AND c.relkind = 'm'
        ORDER BY c.relname`,
    );
    return rows;
  };

  it('finds the certified matviews, so the test cannot pass vacuously', async () => {
    expect((await matviews()).length).toBeGreaterThanOrEqual(6);
  });

  it('app_role cannot SELECT any matview directly', async () => {
    const readable = (await matviews()).filter((m) => m.app_can_read).map((m) => m.name);
    expect(readable).toEqual([]);
  });

  it('every matview has a security_barrier view in front of it', async () => {
    // A revoked matview with no wrapper is not a leak — it is a dead report. Both
    // halves have to be there for the data to be both safe and reachable.
    const { rows } = await pool.query<{ name: string; barrier: boolean; app_can_read: boolean }>(
      `SELECT c.relname AS name,
              coalesce((SELECT option_value = 'true' FROM pg_options_to_table(c.reloptions)
                         WHERE option_name = 'security_barrier'), false) AS barrier,
              has_table_privilege('app_role', c.oid, 'SELECT') AS app_can_read
         FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
        WHERE n.nspname = 'public' AND c.relkind = 'v' AND c.relname LIKE 'v\_%'`,
    );
    const wrappers = new Map(rows.map((r) => [r.name, r]));

    for (const mv of await matviews()) {
      const wrapper = wrappers.get(mv.name.replace(/^mv_/, 'v_'));
      expect(wrapper, `${mv.name} has no v_ wrapper — the report cannot read it`).toBeDefined();
      // security_barrier stops a cheap user-supplied function being pushed below
      // the predicate and seeing rows the filter was meant to hide.
      expect(wrapper!.barrier, `${wrapper!.name} is not a security_barrier view`).toBe(true);
      expect(wrapper!.app_can_read, `${wrapper!.name} is not readable by app_role`).toBe(true);
    }
  });
});
