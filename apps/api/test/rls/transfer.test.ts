import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import pg from 'pg';
import { TransferService } from '../../src/assignment/transfer.service.js';
import type { RlsSession } from '../../src/db/rls-context.js';

/**
 * MOVING WORK THAT IS ALREADY SOMEBODY'S.
 *
 * Against a live database, because every property here is a property of the SQL:
 * the guard that stops a stale selection moving a lead someone else already took,
 * the append-only row that finally carries `from_employee_id`, and the invariant
 * that the number of leads moved equals the number of ledger rows written. A unit
 * test over the service with a mocked client would assert that the code I wrote
 * is the code I wrote.
 */

const DATABASE_URL = process.env['DATABASE_URL'];

let pool: pg.Pool;
let service: TransferService;
let admin: RlsSession;
let repA: string;
let repB: string;
let customerId: string;
const probeLeads: string[] = [];

/** A fresh lead on repA. Each test gets its own so order cannot matter. */
async function leadOn(employeeId: string): Promise<string> {
  const { rows: [l] } = await pool.query<{ lead_id: string }>(
    `INSERT INTO lead (customer_id, source_id, assigned_to, assigned_at, received_at, valid_till)
     SELECT $1, source_id, $2, now() - interval '3 days', now() - interval '3 days',
            (CURRENT_DATE + 30)
       FROM lead_source ORDER BY code LIMIT 1
     RETURNING lead_id`,
    [customerId, employeeId],
  );
  probeLeads.push(l!.lead_id);
  return l!.lead_id;
}

const held = async (leadId: string) => {
  const { rows: [r] } = await pool.query<{ assigned_to: string | null; assigned_at: string | null }>(
    `SELECT assigned_to, assigned_at::text FROM lead WHERE lead_id = $1`,
    [leadId],
  );
  return r!;
};

beforeAll(async () => {
  if (!DATABASE_URL) {
    throw new Error('DATABASE_URL is not set. These tests require a live database and will not skip.');
  }
  pool = new pg.Pool({ connectionString: DATABASE_URL });
  service = new TransferService(pool);

  const { rows: [a] } = await pool.query<{ user_id: string }>(
    `SELECT user_id FROM app_user WHERE role = 'ADMIN' AND NOT is_locked ORDER BY email LIMIT 1`,
  );
  if (!a) throw new Error('need an unlocked admin. Run db:seed.');
  admin = { userId: a.user_id, role: 'ADMIN' };

  // Seeded roster only, for the reason every other fixture pins it (D-306).
  const { rows: reps } = await pool.query<{ employee_id: string }>(
    `SELECT employee_id FROM employee
      WHERE status = 'ACTIVE' AND emp_code LIKE 'EMP-%'
      ORDER BY emp_code LIMIT 2`,
  );
  if (reps.length < 2) throw new Error('need two active reps. Run db:seed.');
  repA = reps[0]!.employee_id;
  repB = reps[1]!.employee_id;

  const { rows: [c] } = await pool.query<{ customer_id: string }>(
    `INSERT INTO customer (primary_phone, full_name) VALUES ('9000000077','Transfer Probe')
     ON CONFLICT (primary_phone) DO UPDATE SET full_name = EXCLUDED.full_name
     RETURNING customer_id`,
  );
  customerId = c!.customer_id;
});

afterAll(async () => {
  // lead_assignment is append-only, so the probe leads are closed rather than
  // deleted — the same correction a human makes, and app_role has no DELETE.
  if (probeLeads.length > 0) {
    await pool
      ?.query(`UPDATE lead SET closed_at = now(), assigned_to = NULL WHERE lead_id = ANY($1::uuid[])`, [
        probeLeads,
      ])
      .catch(() => undefined);
  }
  await pool?.end();
});

describe('moving work off a rep', () => {
  it('moves the lead, and writes exactly one ledger row per lead moved', async () => {
    const one = await leadOn(repA);
    const two = await leadOn(repA);

    const r = await service.transfer(admin, {
      leadIds: [one, two],
      fromEmployeeId: repA,
      to: { kind: 'REP', toEmployeeId: repB },
      reason: 'Priya is on leave this week',
    });

    expect(r.moved).toBe(2);
    // The invariant that makes the history explain the present. If these ever
    // diverge, a past month's assignment is no longer reconstructable.
    expect(r.assignmentRowsWritten).toBe(r.moved);
    expect(r.skipped).toBe(0);
    expect((await held(one)).assigned_to).toBe(repB);
    expect((await held(two)).assigned_to).toBe(repB);
  });

  it('records where the lead CAME FROM — the column every earlier path left NULL', async () => {
    const id = await leadOn(repA);
    await service.transfer(admin, {
      leadIds: [id],
      fromEmployeeId: repA,
      to: { kind: 'REP', toEmployeeId: repB },
      reason: 'wrong rep, customer asked for Divya',
    });

    const { rows: [row] } = await pool.query<{
      from_employee_id: string | null; to_employee_id: string | null; method: string; reason: string;
    }>(
      `SELECT from_employee_id, to_employee_id, method::text, reason
         FROM lead_assignment WHERE lead_id = $1 ORDER BY assigned_at DESC LIMIT 1`,
      [id],
    );
    expect(row!.from_employee_id).toBe(repA);
    expect(row!.to_employee_id).toBe(repB);
    expect(row!.method).toBe('TRANSFER');
    expect(row!.reason).toBe('wrong rep, customer asked for Divya');
  });

  it('sends a lead back to the pool as a RECALL, and clears the clock with it', async () => {
    const id = await leadOn(repA);
    const before = await held(id);
    expect(before.assigned_at).not.toBeNull();

    const r = await service.transfer(admin, {
      leadIds: [id],
      fromEmployeeId: repA,
      to: { kind: 'POOL' },
      reason: 'rep exited, returning her open leads',
    });

    expect(r.moved).toBe(1);
    const after = await held(id);
    expect(after.assigned_to).toBeNull();
    // A lead sitting in the pool with an assignment timestamp would be counted as
    // untouched-for-N-days against nobody.
    expect(after.assigned_at).toBeNull();

    const { rows: [row] } = await pool.query<{ method: string; to_employee_id: string | null }>(
      `SELECT method::text, to_employee_id FROM lead_assignment
        WHERE lead_id = $1 ORDER BY assigned_at DESC LIMIT 1`,
      [id],
    );
    expect(row!.method).toBe('RECALL');
    expect(row!.to_employee_id).toBeNull();
  });

  it('gives the receiving rep a FRESH 48/72-hour clock, not the sender stale one', async () => {
    // The lead was assigned three days ago. Inheriting that timestamp hands the
    // new rep a lead the recall job would pull back before she has seen it.
    const id = await leadOn(repA);
    await service.transfer(admin, {
      leadIds: [id],
      fromEmployeeId: repA,
      to: { kind: 'REP', toEmployeeId: repB },
      reason: 'rebalancing, Akruti has too many',
    });

    const { rows: [r] } = await pool.query<{ age_hours: number }>(
      `SELECT round(extract(epoch from now() - assigned_at) / 3600)::int AS age_hours
         FROM lead WHERE lead_id = $1`,
      [id],
    );
    expect(r!.age_hours).toBeLessThan(1);
  });
});

describe('what a transfer refuses to do', () => {
  it('does not move a lead the "from" rep no longer holds', async () => {
    // THE STALE-SELECTION CASE. The admin ticked this lead on a screen rendered a
    // minute ago; since then another admin moved it. Without `assigned_to = $from`
    // in the predicate this would silently take it off whoever has it now.
    const id = await leadOn(repA);
    await pool.query(`UPDATE lead SET assigned_to = $2 WHERE lead_id = $1`, [id, repB]);

    const r = await service.transfer(admin, {
      leadIds: [id],
      fromEmployeeId: repA,
      to: { kind: 'POOL' },
      reason: 'clearing out an old selection',
    });

    expect(r.moved).toBe(0);
    expect(r.skipped).toBe(1);
    expect((await held(id)).assigned_to).toBe(repB);
  });

  it('leaves a converted lead where it is', async () => {
    const id = await leadOn(repA);
    await pool.query(`UPDATE lead SET is_converted = true WHERE lead_id = $1`, [id]);

    const r = await service.transfer(admin, {
      leadIds: [id],
      fromEmployeeId: repA,
      to: { kind: 'REP', toEmployeeId: repB },
      reason: 'tidying up the assignment list',
    });

    expect(r.moved).toBe(0);
    expect(r.skipped).toBe(1);
    expect((await held(id)).assigned_to).toBe(repA);
  });

  it('refuses an empty reason — the ledger has to answer "why did I lose that lead"', async () => {
    const id = await leadOn(repA);
    await expect(
      service.transfer(admin, {
        leadIds: [id],
        fromEmployeeId: repA,
        to: { kind: 'REP', toEmployeeId: repB },
        reason: '   ',
      }),
    ).rejects.toThrow(/reason is required/i);
    expect((await held(id)).assigned_to).toBe(repA);
  });

  it('refuses to move a lead to the rep who already has it', async () => {
    const id = await leadOn(repA);
    await expect(
      service.transfer(admin, {
        leadIds: [id],
        fromEmployeeId: repA,
        to: { kind: 'REP', toEmployeeId: repA },
        reason: 'this should not be allowed',
      }),
    ).rejects.toThrow(/already holds/i);
  });

  it('refuses a REP session outright, whatever the leads', async () => {
    // The controller is behind AdminGuard, but the rule belongs with the write:
    // this service will have another caller eventually.
    const id = await leadOn(repA);
    const { rows: [u] } = await pool.query<{ user_id: string }>(
      `SELECT u.user_id FROM app_user u JOIN employee e ON e.user_id = u.user_id
        WHERE u.role = 'EMPLOYEE' AND e.emp_code LIKE 'EMP-%' ORDER BY e.emp_code LIMIT 1`,
    );
    await expect(
      service.transfer(
        { userId: u!.user_id, role: 'EMPLOYEE' },
        {
          leadIds: [id],
          fromEmployeeId: repA,
          to: { kind: 'POOL' },
          reason: 'a rep should not be able to do this',
        },
      ),
    ).rejects.toThrow(/only an admin/i);
    expect((await held(id)).assigned_to).toBe(repA);
  });

  it('writes nothing at all when nothing moved', async () => {
    // A no-op that still wrote an audit row and a ledger row would put a
    // transfer in the history that never happened.
    const id = await leadOn(repA);
    await pool.query(`UPDATE lead SET closed_at = now() WHERE lead_id = $1`, [id]);

    const { rows: [before] } = await pool.query<{ n: string }>(
      `SELECT count(*)::text AS n FROM lead_assignment WHERE lead_id = $1`,
      [id],
    );
    const r = await service.transfer(admin, {
      leadIds: [id],
      fromEmployeeId: repA,
      to: { kind: 'POOL' },
      reason: 'closed lead should not move',
    });
    const { rows: [after] } = await pool.query<{ n: string }>(
      `SELECT count(*)::text AS n FROM lead_assignment WHERE lead_id = $1`,
      [id],
    );

    expect(r.moved).toBe(0);
    expect(after!.n).toBe(before!.n);
  });
});
