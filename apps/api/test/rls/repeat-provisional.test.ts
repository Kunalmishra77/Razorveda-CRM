import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import pg from 'pg';
import { SYSTEM_ACTOR_EMAIL } from '@razorveda/shared';
import { RepeatService } from '../../src/leads/repeat.service.js';
import type { RlsSession } from '../../src/db/rls-context.js';

/**
 * A REPEAT LEAD MUST CARRY WHETHER ITS TIMING IS A GUESS.
 *
 * The repeat engine schedules from `sku.usage_days`, and every one of those
 * numbers is currently reverse-engineered from the client's order data (O-03).
 * That was harmless for as long as the engine never ran. It now runs daily
 * (D-254), so those guesses decide which customer a rep rings on which day.
 *
 * The decision was to keep scheduling - a missed reorder is worse than an early
 * call - and to tell the rep the date is an estimate. This suite holds that
 * promise, and one thing that is easy to get wrong about it:
 *
 *   confirming a SKU next month must NOT rewrite the flag on a lead the rep
 *   already worked. What she was told at the time is the fact; a later
 *   confirmation cannot retroactively make her call a confirmed one.
 *
 * The service is called DIRECTLY rather than over HTTP. It is a plain class that
 * takes a pool, the endpoint in front of it is admin-only and admins need TOTP,
 * and what is under test here is the data flow rather than the authorisation -
 * which adversarial.test.ts already covers.
 */

const DATABASE_URL = process.env['DATABASE_URL'];

let pool: pg.Pool;
let session: RlsSession;
let repeats: RepeatService;

beforeAll(async () => {
  if (!DATABASE_URL) {
    throw new Error('DATABASE_URL is not set. These tests require a live database and will not skip.');
  }
  pool = new pg.Pool({ connectionString: DATABASE_URL });
  repeats = new RepeatService(pool);

  const { rows } = await pool.query<{ user_id: string; role: string }>(
    'SELECT user_id, role FROM auth_lookup($1)',
    [SYSTEM_ACTOR_EMAIL],
  );
  const actor = rows[0];
  if (!actor) throw new Error(`${SYSTEM_ACTOR_EMAIL} is not seeded — run npm run db:seed`);
  session = { userId: actor.user_id, role: actor.role as RlsSession['role'] };
});

/**
 * NOTHING IS DELETED, AND THAT IS NOT AN OVERSIGHT.
 *
 * The first version tore its fixtures down and failed:
 *
 *   Table lead_assignment is append-only. Write a new row instead of DELETE
 *   (see CLAUDE.md rule 2).
 *
 * The trigger refuses the DELETE even for the table OWNER, which is the whole
 * point of rule 2 - it is what makes a March report reproducible in December, and
 * a test tidying up is not a good enough reason to reach around it. Disabling the
 * trigger to clean up would be strictly worse: the one test run where somebody
 * forgets to re-enable it leaves the audit trail mutable.
 *
 * `lead_assignment` also references `lead`, which references `customer`, so the
 * whole chain has to stay.
 *
 * The cost is a handful of fixture customers left in the DEV database. That is
 * acceptable: CI builds from empty on every run (D-249), assertions here are
 * scoped to a specific customer_id so accumulation cannot skew them, and the
 * fixtures are named "Repeat Fixture ..." so nobody mistakes them for real data.
 */
afterAll(async () => {
  await pool?.end();
});

/**
 * A customer who is due today, owned by a real rep, with no open repeat lead.
 * `provisional` is what the SKU's usage_days confidence would have written.
 */
async function customerDueToday(provisional: boolean): Promise<string> {
  const { rows: [rep] } = await pool.query<{ employee_id: string }>(
    `SELECT e.employee_id FROM employee e JOIN app_user u ON u.user_id = e.user_id
      WHERE u.role = 'EMPLOYEE' AND e.status = 'ACTIVE' AND e.emp_code LIKE 'EMP-%'
      ORDER BY e.emp_code LIMIT 1`,
  );
  if (!rep) throw new Error('no active rep seeded — run npm run db:seed:dev');

  const { rows: [c] } = await pool.query<{ customer_id: string }>(
    `INSERT INTO customer (full_name, primary_phone, owner_employee_id,
                           next_due_date, next_due_date_provisional)
     VALUES ($1, $2, $3, CURRENT_DATE, $4)
     RETURNING customer_id`,
    [
      `Repeat Fixture ${provisional ? 'Estimated' : 'Confirmed'}`,
      // A valid 10-digit Indian mobile, unique per run so re-runs do not collide
      // on the primary_phone constraint.
      `9${String(Date.now()).slice(-9)}`,
      rep.employee_id,
      provisional,
    ],
  );
  return c!.customer_id;
}

async function leadFor(customerId: string) {
  const { rows } = await pool.query<{ lead_id: string; timing_provisional: boolean }>(
    `SELECT l.lead_id, l.timing_provisional
       FROM lead l JOIN lead_source s ON s.source_id = l.source_id
      WHERE l.customer_id = $1 AND s.code = 'DELIVERED_REPEAT'`,
    [customerId],
  );
  return rows;
}

describe('a repeat lead built from an unconfirmed usage_days', () => {
  it('is marked provisional, and the lead is still created', async () => {
    const customerId = await customerDueToday(true);

    const result = await repeats.materialiseDue(session, new Date().toISOString().slice(0, 10));
    expect(result.leadsCreated, 'no repeat lead was created at all').toBeGreaterThanOrEqual(1);

    const leads = await leadFor(customerId);
    expect(leads, 'the due customer got no repeat lead').toHaveLength(1);
    expect(
      leads[0]!.timing_provisional,
      'The lead was created from a guessed usage_days and is NOT flagged. The rep will be ' +
        'told to call on a date the system invented, with no indication it is an estimate.',
    ).toBe(true);
  });

  it('a confirmed usage_days produces a lead with no caveat', async () => {
    const customerId = await customerDueToday(false);

    await repeats.materialiseDue(session, new Date().toISOString().slice(0, 10));

    const leads = await leadFor(customerId);
    expect(leads).toHaveLength(1);
    expect(
      leads[0]!.timing_provisional,
      'A confirmed figure produced a lead marked as an estimate. Crying wolf on every ' +
        'lead is how a caveat stops being read.',
    ).toBe(false);
  });

  it('confirming the SKU afterwards does NOT rewrite a lead already issued', async () => {
    // The property that makes the flag trustworthy. If confirming a SKU silently
    // relabelled past leads, the record of what the rep was told when she made
    // the call would change under her - and "did she know?" becomes unanswerable.
    const customerId = await customerDueToday(true);
    await repeats.materialiseDue(session, new Date().toISOString().slice(0, 10));

    const before = await leadFor(customerId);
    expect(before[0]!.timing_provisional).toBe(true);

    // Confirm every SKU, the strongest version of the change.
    await pool.query('UPDATE sku SET usage_days_confirmed = true WHERE usage_days IS NOT NULL');

    const after = await leadFor(customerId);
    expect(
      after[0]!.timing_provisional,
      'Confirming a SKU changed the flag on a lead that was already issued. The lead ' +
        'must record what was known when the rep was told to call.',
    ).toBe(true);

    // Put the fixture back: these values are guesses until O-03 is answered, and
    // leaving them confirmed would make every later test lie about provenance.
    await pool.query('UPDATE sku SET usage_days_confirmed = false');
  });

  it('the flag is cleared on the customer once the lead exists', async () => {
    // next_due_date and its provisional flag are consumed together. A stale TRUE
    // left behind would mark the NEXT cycle as an estimate even after the SKU was
    // confirmed - the caveat outliving the reason for it.
    const customerId = await customerDueToday(true);
    await repeats.materialiseDue(session, new Date().toISOString().slice(0, 10));

    const { rows } = await pool.query<{ next_due_date: string | null; next_due_date_provisional: boolean }>(
      'SELECT next_due_date, next_due_date_provisional FROM customer WHERE customer_id = $1',
      [customerId],
    );
    expect(rows[0]!.next_due_date).toBeNull();
    expect(rows[0]!.next_due_date_provisional).toBe(false);
  });
});

describe('the columns this depends on', () => {
  it('exist, and default to "not confirmed"', async () => {
    // The defaults are the safe direction: a column added without a default, or
    // defaulting to TRUE, would silently assert that every seeded guess had been
    // vouched for by a human.
    const { rows } = await pool.query<{ table_name: string; column_name: string; column_default: string | null }>(
      `SELECT table_name, column_name, column_default
         FROM information_schema.columns
        WHERE (table_name, column_name) IN
              (('sku','usage_days_confirmed'),
               ('customer','next_due_date_provisional'),
               ('lead','timing_provisional'))`,
    );
    expect(rows, 'a column this feature depends on is missing').toHaveLength(3);
    for (const r of rows) {
      expect(r.column_default, `${r.table_name}.${r.column_name} has no default`).toMatch(/false/);
    }
  });

  it('no seeded usage_days is marked confirmed, because none has been', async () => {
    const { rows } = await pool.query<{ n: string }>(
      'SELECT count(*)::text AS n FROM sku WHERE usage_days_confirmed',
    );
    expect(
      Number(rows[0]!.n),
      'A seeded usage_days is marked confirmed. Those values are reverse-engineered ' +
        'guesses (O-03); marking them confirmed hides that from every rep.',
    ).toBe(0);
  });
});
