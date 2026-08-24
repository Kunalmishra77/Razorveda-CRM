import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import pg from 'pg';
import { UNTOUCHED_ALERT_HOURS, UNTOUCHED_RECALL_HOURS } from '@razorveda/shared';
import { FollowupService } from '../../src/leads/followup.service.js';
import type { RlsSession } from '../../src/db/rls-context.js';

/**
 * PHASE 3 CRITERION 6 — the only automatic lead movement in the system.
 *
 * Against a live database, because the rule IS the SQL: "untouched" means no
 * activity row since `assigned_at`, and a pure unit test could only assert the
 * two constants, which is the part nobody gets wrong.
 *
 * The boundaries are tested from both sides. An off-by-one here does not throw or
 * log — it silently takes a lead off a rep an hour early, or leaves it rotting an
 * hour late, and the only symptom is a rep insisting she was robbed.
 */

const DATABASE_URL = process.env['DATABASE_URL'];

let pool: pg.Pool;
let service: FollowupService;
let admin: RlsSession;
/** Untouched throughout — the alert and recall subject. */
let leadId: string;
/** Called after assignment. */
let leadWorked: string;
/** Called BEFORE assignment, by a previous owner. */
let leadStale: string;
let repId: string;
let customerId: string;
const assignedAt = new Date('2026-06-01T09:00:00.000Z');

/** Hours after assignment, as an ISO instant. */
const at = (hours: number): string =>
  new Date(assignedAt.getTime() + hours * 3_600_000).toISOString();

beforeAll(async () => {
  if (!DATABASE_URL) {
    throw new Error('DATABASE_URL is not set. These tests require a live database and will not skip.');
  }
  pool = new pg.Pool({ connectionString: DATABASE_URL });
  service = new FollowupService(pool);

  const { rows: [a] } = await pool.query<{ user_id: string }>(
    `SELECT user_id FROM app_user WHERE role = 'ADMIN' AND NOT is_locked ORDER BY email LIMIT 1`,
  );
  if (!a) throw new Error('need an unlocked admin. Run db:seed.');
  admin = { userId: a.user_id, role: 'ADMIN' };

  const { rows: [rep] } = await pool.query<{ employee_id: string }>(
    `SELECT employee_id FROM employee WHERE status = 'ACTIVE' AND emp_code LIKE 'EMP-%' ORDER BY emp_code LIMIT 1`,
  );
  if (!rep) throw new Error('need an active employee. Run db:seed.');
  repId = rep.employee_id;

  // A dedicated customer and lead, so the assertions are about THIS lead rather
  // than about whatever the seed happens to contain.
  const { rows: [c] } = await pool.query<{ customer_id: string }>(
    `INSERT INTO customer (primary_phone, full_name) VALUES ('9000000001','Recall Probe')
     ON CONFLICT (primary_phone) DO UPDATE SET full_name = EXCLUDED.full_name
     RETURNING customer_id`,
  );
  customerId = c!.customer_id;

  // Three leads, not one with its history edited between assertions. `activity`
  // is append-only and the trigger refuses a DELETE — correctly, and the first
  // version of this test tried anyway. A scenario per lead is what the rule
  // actually permits, and it is also closer to what happens in production.
  const newLead = async (): Promise<string> => {
    const { rows: [l] } = await pool.query<{ lead_id: string }>(
      `INSERT INTO lead (customer_id, source_id, assigned_to, assigned_at, received_at, valid_till)
       SELECT $1, source_id, $2, $3, $3, (CURRENT_DATE + 30)
         FROM lead_source ORDER BY code LIMIT 1
       RETURNING lead_id`,
      [customerId, repId, assignedAt],
    );
    return l!.lead_id;
  };
  leadId = await newLead();
  leadWorked = await newLead();
  leadStale = await newLead();

  const call = (lead: string, hours: number) =>
    pool.query(
      `INSERT INTO activity (lead_id, customer_id, employee_id, type, connected, occurred_at)
       VALUES ($1,$2,$3,'CALL',true,$4)`,
      [lead, customerId, repId, at(hours)],
    );
  await call(leadWorked, 10);
  await call(leadStale, -5);
});

afterAll(async () => {
  // Closed, not deleted. `activity` and `lead_assignment` are append-only and the
  // trigger refuses a DELETE, so tearing the probe rows out is not available —
  // which is the correct behaviour, and the same correction a human would make.
  await pool
    ?.query(`UPDATE lead SET closed_at = now(), assigned_to = NULL WHERE lead_id = ANY($1::uuid[])`, [
      [leadId, leadWorked, leadStale],
    ])
    .catch(() => undefined);
  await pool?.end();
});

const listed = async (hours: number, lead: string = leadId): Promise<boolean> => {
  const rows = await service.findUntouched(admin, at(hours), UNTOUCHED_ALERT_HOURS);
  return rows.some((r) => r.leadId === lead);
};

describe('the 48h alert', () => {
  it('says nothing an hour early', async () => {
    expect(await listed(UNTOUCHED_ALERT_HOURS - 1)).toBe(false);
  });

  it('fires exactly on the threshold', async () => {
    expect(await listed(UNTOUCHED_ALERT_HOURS)).toBe(true);
  });

  it('reports how long it has been sitting', async () => {
    const rows = await service.findUntouched(admin, at(60), UNTOUCHED_ALERT_HOURS);
    expect(rows.find((r) => r.leadId === leadId)?.hoursUntouched).toBe(60);
  });
});

describe('what counts as touched', () => {
  it('a call recorded AFTER assignment clears the lead from the alert', async () => {
    expect(await listed(UNTOUCHED_ALERT_HOURS, leadWorked)).toBe(false);
  });

  it('a call recorded BEFORE assignment does not count', async () => {
    // A lead transferred from one rep to another starts its clock again. Without
    // this, the previous rep's calls would buy the new one three free days on a
    // customer nobody has spoken to since the handover.
    expect(await listed(UNTOUCHED_ALERT_HOURS, leadStale)).toBe(true);
  });
});

describe('the 72h recall', () => {
  it('does not fire an hour early', async () => {
    const result = await service.recallUntouched(admin, at(UNTOUCHED_RECALL_HOURS - 1));
    expect(result.leads.some((l) => l.leadId === leadId)).toBe(false);
  });

  it('returns the lead to the pool exactly on the threshold, with a RECALL row', async () => {
    const result = await service.recallUntouched(admin, at(UNTOUCHED_RECALL_HOURS));
    expect(result.leads.some((l) => l.leadId === leadId)).toBe(true);

    const { rows: [lead] } = await pool.query<{ assigned_to: string | null }>(
      `SELECT assigned_to FROM lead WHERE lead_id = $1`,
      [leadId],
    );
    // assigned_to IS NULL is the pool (D-76) — there is no separate flag, so the
    // recall is one UPDATE and cannot half-happen.
    expect(lead!.assigned_to).toBeNull();

    const { rows: [entry] } = await pool.query<{
      method: string; from_employee_id: string | null; to_employee_id: string | null;
    }>(
      `SELECT method, from_employee_id, to_employee_id FROM lead_assignment
        WHERE lead_id = $1 ORDER BY assigned_at DESC LIMIT 1`,
      [leadId],
    );
    expect(entry).toMatchObject({ method: 'RECALL', from_employee_id: repId, to_employee_id: null });
  });

  it('is idempotent — a lead already in the pool is not recalled again', async () => {
    // The job runs on a schedule and gets retried. A second RECALL row against a
    // lead that is already unassigned would tell an admin it was taken from a rep
    // who no longer had it.
    const before = await countRecalls();
    await service.recallUntouched(admin, at(UNTOUCHED_RECALL_HOURS + 24));
    expect(await countRecalls()).toBe(before);
  });
});

async function countRecalls(): Promise<number> {
  const { rows: [r] } = await pool.query<{ n: string }>(
    `SELECT count(*)::text AS n FROM lead_assignment WHERE lead_id = $1 AND method = 'RECALL'`,
    [leadId],
  );
  return Number(r?.n ?? '0');
}
