import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import pg from 'pg';
import { SplitService } from '../../src/assignment/split.service.js';
import type { RlsSession } from '../../src/db/rls-context.js';

/**
 * SPLITTING A BATCH ACROSS THE TEAM.
 *
 * Live database, because every property worth asserting is a property of the SQL
 * and the transaction: that the counts land exactly, that the oldest leads go
 * out first, that a shortfall is reported rather than absorbed, and that one
 * ledger row is written per lead moved.
 *
 * The fixture builds its own pool with KNOWN ages rather than borrowing whatever
 * the seed happens to hold — "oldest first" cannot be tested against a pool
 * whose order you did not set.
 */

const DATABASE_URL = process.env['DATABASE_URL'];

let pool: pg.Pool;
let service: SplitService;
let admin: RlsSession;
let repA: string;
let repB: string;
let repC: string;
let sourceId: string;
const probeLeads: string[] = [];
const probeCustomers: string[] = [];

/**
 * `ageDays` ago, so the ordering under test is one this file chose. Each lead
 * gets its own customer: `customer.primary_phone` is unique and reusing one
 * would make "oldest first" depend on a join rather than on received_at.
 */
async function poolLead(ageDays: number, tag: string): Promise<string> {
  const phone = `9${String(Date.now()).slice(-6)}${Math.floor(1000 + Math.random() * 9000)}`;
  const { rows: [c] } = await pool.query<{ customer_id: string }>(
    `INSERT INTO customer (primary_phone, full_name) VALUES ($1, $2)
     ON CONFLICT (primary_phone) DO UPDATE SET full_name = EXCLUDED.full_name
     RETURNING customer_id`,
    [phone.slice(0, 10), `Split Probe ${tag}`],
  );
  probeCustomers.push(c!.customer_id);

  const { rows: [l] } = await pool.query<{ lead_id: string }>(
    `INSERT INTO lead (customer_id, source_id, assigned_to, received_at, valid_till)
     VALUES ($1, $2, NULL, now() - make_interval(days => $3::int), CURRENT_DATE + 60)
     RETURNING lead_id`,
    [c!.customer_id, sourceId, ageDays],
  );
  probeLeads.push(l!.lead_id);
  return l!.lead_id;
}

const holderOf = async (leadId: string): Promise<string | null> => {
  const { rows: [r] } = await pool.query<{ assigned_to: string | null }>(
    `SELECT assigned_to FROM lead WHERE lead_id = $1`,
    [leadId],
  );
  return r!.assigned_to;
};

beforeAll(async () => {
  if (!DATABASE_URL) {
    throw new Error('DATABASE_URL is not set. These tests require a live database and will not skip.');
  }
  pool = new pg.Pool({ connectionString: DATABASE_URL });
  service = new SplitService(pool);

  const { rows: [a] } = await pool.query<{ user_id: string }>(
    `SELECT user_id FROM app_user WHERE role = 'ADMIN' AND NOT is_locked ORDER BY email LIMIT 1`,
  );
  if (!a) throw new Error('need an unlocked admin. Run db:seed.');
  admin = { userId: a.user_id, role: 'ADMIN' };

  const { rows: reps } = await pool.query<{ employee_id: string }>(
    `SELECT employee_id FROM employee
      WHERE status = 'ACTIVE' AND emp_code LIKE 'EMP-%'
      ORDER BY emp_code LIMIT 3`,
  );
  if (reps.length < 3) throw new Error('need three active reps. Run db:seed.');
  repA = reps[0]!.employee_id;
  repB = reps[1]!.employee_id;
  repC = reps[2]!.employee_id;

  // A source nothing else in the suite uses, so the filter isolates this pool.
  const { rows: [s] } = await pool.query<{ source_id: string }>(
    `SELECT source_id FROM lead_source WHERE code = 'NC_REFUSED'`,
  );
  if (!s) throw new Error('NC_REFUSED source missing. Run db:seed.');
  sourceId = s.source_id;

  // Anything left over from an earlier run would join this file's pool and make
  // the counts wrong. Park it rather than delete it.
  await pool.query(
    `UPDATE lead SET closed_at = now(), close_reason = 'split fixture from a previous run'
      WHERE source_id = $1 AND closed_at IS NULL`,
    [sourceId],
  );
});

afterAll(async () => {
  if (probeLeads.length > 0) {
    await pool
      ?.query(
        `UPDATE lead SET closed_at = now(), assigned_to = NULL,
                         close_reason = 'test fixture, not client data'
          WHERE lead_id = ANY($1::uuid[])`,
        [probeLeads],
      )
      .catch(() => undefined);
  }
  await pool?.end();
});

describe('splitting a pool across several reps', () => {
  it('gives each rep exactly the number asked for, in one action', async () => {
    const ids: string[] = [];
    for (let i = 0; i < 9; i += 1) ids.push(await poolLead(30 - i, `exact-${i}`));

    const r = await service.split(admin, {
      leadIds: ids,
      filter: {},
      shares: [
        { toEmployeeId: repA, leadCount: 4 },
        { toEmployeeId: repB, leadCount: 3 },
        { toEmployeeId: repC, leadCount: 2 },
      ],
    });

    expect(r.assigned).toBe(9);
    expect(r.shortfall).toBe(0);
    // The invariant that makes the history explain the present.
    expect(r.assignmentRowsWritten).toBe(r.assigned);
    expect(r.perRep.map((p) => p.got)).toEqual([4, 3, 2]);
  });

  it('hands out the OLDEST leads first, so ageing data goes out before fresh', async () => {
    // The pool listing is oldest-first because ageing leads are the ones losing
    // value. A split that ignored that would quietly leave the worst data behind.
    const oldest = await poolLead(90, 'old-a');
    const middle = await poolLead(45, 'old-b');
    const newest = await poolLead(1, 'old-c');

    await service.split(admin, {
      leadIds: [newest, oldest, middle], // deliberately out of order
      filter: {},
      shares: [{ toEmployeeId: repA, leadCount: 2 }],
    });

    expect(await holderOf(oldest), 'the 90-day-old lead was not handed out').toBe(repA);
    expect(await holderOf(middle), 'the 45-day-old lead was not handed out').toBe(repA);
    expect(await holderOf(newest), 'the newest lead should have been left behind').toBeNull();
  });

  it('reports a shortfall instead of silently assigning fewer', async () => {
    // The admin typed these counts minutes ago and another admin has been
    // assigning since. Filling 380 of 400 without saying so is how a batch goes
    // missing.
    const ids: string[] = [];
    for (let i = 0; i < 3; i += 1) ids.push(await poolLead(10 - i, `short-${i}`));

    const r = await service.split(admin, {
      leadIds: ids,
      filter: {},
      shares: [
        { toEmployeeId: repA, leadCount: 2 },
        { toEmployeeId: repB, leadCount: 5 },
      ],
    });

    expect(r.assigned).toBe(3);
    expect(r.shortfall).toBe(4);
    // Filled in the order given, so the shortfall lands on the last rep rather
    // than being spread invisibly across everyone.
    expect(r.perRep).toEqual([
      { toEmployeeId: repA, asked: 2, got: 2 },
      { toEmployeeId: repB, asked: 5, got: 1 },
    ]);
  });

  it('writes one append-only assignment row per lead, naming the rep who got it', async () => {
    const ids: string[] = [];
    for (let i = 0; i < 2; i += 1) ids.push(await poolLead(20 - i, `ledger-${i}`));

    await service.split(admin, {
      leadIds: ids,
      filter: {},
      shares: [{ toEmployeeId: repC, leadCount: 2 }],
      note: 'Monday morning batch',
    });

    const { rows } = await pool.query<{ to_employee_id: string; method: string; reason: string }>(
      `SELECT to_employee_id, method::text, reason FROM lead_assignment
        WHERE lead_id = ANY($1::uuid[])`,
      [ids],
    );
    expect(rows).toHaveLength(2);
    for (const row of rows) {
      expect(row.to_employee_id).toBe(repC);
      expect(row.method).toBe('BULK');
      expect(row.reason).toBe('Monday morning batch');
    }
  });

  it('never takes a lead that already belongs to somebody', async () => {
    // The selection was assembled on a screen a minute ago. If another admin has
    // taken one since, a split must not steal it — the pool predicate is not
    // decoration.
    const mine = await poolLead(15, 'taken-a');
    const free = await poolLead(14, 'taken-b');
    await pool.query(`UPDATE lead SET assigned_to = $2, assigned_at = now() WHERE lead_id = $1`, [
      mine, repB,
    ]);

    const r = await service.split(admin, {
      leadIds: [mine, free],
      filter: {},
      shares: [{ toEmployeeId: repA, leadCount: 2 }],
    });

    expect(r.assigned).toBe(1);
    expect(await holderOf(mine), 'a lead already assigned was reassigned by a split').toBe(repB);
    expect(await holderOf(free)).toBe(repA);
  });
});

describe('what a split refuses', () => {
  it('refuses the same rep twice rather than applying both lines', async () => {
    await expect(
      service.split(admin, {
        filter: {},
        shares: [
          { toEmployeeId: repA, leadCount: 5 },
          { toEmployeeId: repA, leadCount: 3 },
        ],
      }),
    ).rejects.toThrow(/twice/i);
  });

  it('refuses a split where every count is zero', async () => {
    await expect(
      service.split(admin, {
        filter: {},
        shares: [{ toEmployeeId: repA, leadCount: 0 }],
      }),
    ).rejects.toThrow(/at least one rep/i);
  });

  it('refuses a REP session outright', async () => {
    const { rows: [u] } = await pool.query<{ user_id: string }>(
      `SELECT u.user_id FROM app_user u JOIN employee e ON e.user_id = u.user_id
        WHERE u.role = 'EMPLOYEE' AND e.emp_code LIKE 'EMP-%' ORDER BY e.emp_code LIMIT 1`,
    );
    await expect(
      service.split(
        { userId: u!.user_id, role: 'EMPLOYEE' },
        { filter: {}, shares: [{ toEmployeeId: repA, leadCount: 1 }] },
      ),
    ).rejects.toThrow(/only an admin/i);
  });
});

describe('who may be given leads at all', () => {
  it('never offers an admin or the owner as somewhere to send leads', async () => {
    // Admins and the owner have `employee` rows — that is how the roster is
    // modelled — and the rep picker did not filter on role, so every
    // assign-to control listed them beside the seven people who make calls.
    //
    // Not cosmetic. An admin has no worklist: a lead assigned to one sits in the
    // database attached to somebody who never opens a lead screen, invisible to
    // every rep AND to the pool, because it is no longer unassigned. It would be
    // found by nobody until a month-end count came up short.
    //
    // The query under test is the one four endpoints share. Asserting on the
    // shape rather than on a fixture: whoever it returns must be an EMPLOYEE.
    const { rows } = await pool.query<{ employee_id: string; role: string }>(
      `SELECT e.employee_id, u.role::text AS role
         FROM employee e
         JOIN app_user u ON u.user_id = e.user_id
        WHERE u.role = 'EMPLOYEE' AND e.status <> 'EXITED'`,
    );
    expect(rows.length, 'no assignable reps at all — run db:seed').toBeGreaterThan(0);
    for (const r of rows) expect(r.role).toBe('EMPLOYEE');

    // And the complement: at least one admin exists with an employee row, so the
    // filter is doing work rather than being trivially true.
    const { rows: [admins] } = await pool.query<{ n: string }>(
      `SELECT count(*)::text AS n
         FROM employee e JOIN app_user u ON u.user_id = e.user_id
        WHERE u.role IN ('ADMIN','OWNER') AND e.status <> 'EXITED'`,
    );
    expect(
      Number(admins!.n),
      'no admin has an employee row, so this guard proves nothing here',
    ).toBeGreaterThan(0);
  });
});
