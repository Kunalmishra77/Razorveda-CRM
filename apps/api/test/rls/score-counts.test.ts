import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import pg from 'pg';
import { EesService } from '../../src/scoring/ees.service.js';
import type { RlsSession } from '../../src/db/rls-context.js';

/**
 * THE FAN-OUT GUARD.
 *
 * The EES cohort query joins orders to the attribution ledger, and an order has
 * SEVERAL ledger rows — BOOKED_CREDIT, REALISED_CREDIT, and a CLAWBACK if it came
 * back. The first version joined them directly, so `count(*) FILTER (WHERE status
 * = 'DELIVERED')` counted order-times-ledger-row: a rep with three delivered
 * orders was scored as having six, and one delivered plus one returned came out
 * as delivered 2, RTO 3.
 *
 * Nothing failed. The run reported success, wrote rows, and was idempotent. The
 * only symptom was a conversion rate of 2.0, and a rate above 1 is the sole reason
 * anyone looked — every other number was merely wrong, not obviously wrong.
 *
 * This lives against a live database because a fan-out is a property of the SQL.
 * No amount of unit testing over `computeScores` can see it: the pure function is
 * correct and was fed inflated inputs.
 */

const DATABASE_URL = process.env['DATABASE_URL'];

let pool: pg.Pool;
let service: EesService;
let admin: RlsSession;
let today: string;
let repId: string;
const probeOrders: string[] = [];
let probeLead: string;

beforeAll(async () => {
  if (!DATABASE_URL) {
    throw new Error('DATABASE_URL is not set. These tests require a live database and will not skip.');
  }
  pool = new pg.Pool({ connectionString: DATABASE_URL });
  service = new EesService(pool);

  const { rows: [a] } = await pool.query<{ user_id: string }>(
    `SELECT user_id FROM app_user WHERE role = 'ADMIN' AND NOT is_locked ORDER BY email LIMIT 1`,
  );
  if (!a) throw new Error('need an unlocked admin. Run db:seed.');
  admin = { userId: a.user_id, role: 'ADMIN' };

  const { rows: [d] } = await pool.query<{ d: string }>(`SELECT CURRENT_DATE::text AS d`);
  today = d!.d;

  // The test builds its own orders rather than relying on whatever the fixture
  // happens to contain. A fresh database has no delivered orders at all, and a
  // guard that quietly passes over an empty set is the thing this file exists to
  // prevent — the fan-out it was written for was invisible precisely because
  // everything "passed".
  const { rows: [rep] } = await pool.query<{ employee_id: string }>(
    `SELECT employee_id FROM employee WHERE status = 'ACTIVE' AND emp_code LIKE 'EMP-%' ORDER BY emp_code LIMIT 1`,
  );
  if (!rep) throw new Error('need an active employee. Run db:seed.');
  repId = rep.employee_id;

  const { rows: [c] } = await pool.query<{ customer_id: string }>(
    `INSERT INTO customer (primary_phone, full_name) VALUES ('9000000009','Score Probe')
     ON CONFLICT (primary_phone) DO UPDATE SET full_name = EXCLUDED.full_name
     RETURNING customer_id`,
  );

  // The orders hang off a real lead assigned to this rep. Not optional: the EES
  // cohort query INNER JOINs `lead`, and a rep only appears at all if she had
  // leads assigned in the period. An order with lead_id NULL is invisible to
  // scoring entirely — worth knowing, and the reason this setup is not shorter.
  const { rows: [lead] } = await pool.query<{ lead_id: string }>(
    `INSERT INTO lead (customer_id, source_id, assigned_to, assigned_at, received_at, valid_till)
     SELECT $1, source_id, $2, now(), now(), (CURRENT_DATE + 30)
       FROM lead_source ORDER BY code LIMIT 1
     RETURNING lead_id`,
    [c!.customer_id, repId],
  );
  probeLead = lead!.lead_id;

  // Two orders for one rep: one delivered, one delivered-then-returned. The
  // second is the shape that exposed the fan-out, because it carries three
  // ledger rows rather than two.
  //
  // The order number carries the run's lead id, so each run gets its own pair.
  // The first version used fixed numbers, cancelled them in afterAll, and then
  // ON CONFLICT DO NOTHING silently skipped recreating them — so the test passed
  // once and afterwards asserted over an empty set. A guard that stops guarding
  // after its first run is worse than no guard.
  for (const [n, outcome] of [['A', 'DELIVERED'], ['B', 'RTO']] as const) {
    const { rows: [o] } = await pool.query<{ order_id: string }>(
      `INSERT INTO "order" (order_number, customer_id, lead_id, source_id,
                            booked_by_employee_id, order_date, final_value,
                            company_base_value, payment_mode, prepaid_amount, cod_amount,
                            current_status, delivered_date, rto_date)
       SELECT 'SCORE-PROBE-' || $2 || '-' || left($5::text, 8), $1, $5::uuid, source_id, $3, CURRENT_DATE, 1000, 0,
              'COD', 0, 1000, $4::order_status, CURRENT_DATE,
              CASE WHEN $4 = 'RTO' THEN CURRENT_DATE ELSE NULL END
         FROM lead_source ORDER BY code LIMIT 1
       ON CONFLICT (order_number) DO NOTHING
       RETURNING order_id`,
      [c!.customer_id, n, repId, outcome, probeLead],
    );
    if (!o) continue;
    probeOrders.push(o.order_id);

    await pool.query(
      `INSERT INTO order_status_event (order_id, from_status, to_status, source)
       VALUES ($1, NULL, 'DELIVERED', 'TEST')`,
      [o.order_id],
    );
    // Several ledger rows per order — the fan-out's raw material.
    await pool.query(
      `INSERT INTO attribution_ledger (order_id, employee_id, entry_type, company_base_value,
                                       employee_credited_value, rule_applied, is_realised, period_key)
       VALUES ($1,$2,'BOOKED_CREDIT',0,1000,'TEST',false,to_char(CURRENT_DATE,'YYYY-MM')),
              ($1,$2,'REALISED_CREDIT',0,1000,'TEST',true,to_char(CURRENT_DATE,'YYYY-MM'))`,
      [o.order_id, repId],
    );
    if (outcome === 'RTO') {
      await pool.query(
        `INSERT INTO order_status_event (order_id, from_status, to_status, source)
         VALUES ($1, 'DELIVERED', 'RTO', 'TEST')`,
        [o.order_id],
      );
      await pool.query(
        `INSERT INTO attribution_ledger (order_id, employee_id, entry_type, company_base_value,
                                         employee_credited_value, rule_applied, is_realised, period_key)
         VALUES ($1,$2,'CLAWBACK',0,-1000,'TEST',true,to_char(CURRENT_DATE,'YYYY-MM'))`,
        [o.order_id, repId],
      );
    }
  }
});

afterAll(async () => {
  // order_status_event and attribution_ledger are append-only, so the probe
  // orders are cancelled rather than deleted — the same correction a human makes.
  await pool?.query(`UPDATE lead SET closed_at = now(), assigned_to = NULL WHERE lead_id = $1`, [
    probeLead,
  ]).catch(() => undefined);
  if (probeOrders.length > 0) {
    await pool
      ?.query(`UPDATE "order" SET current_status = 'CANCELLED' WHERE order_id = ANY($1::uuid[])`, [
        probeOrders,
      ])
      .catch(() => undefined);
  }
  await pool?.end();
});

describe('the scored counts match the orders that actually exist', () => {
  it('never reports a conversion rate above 1 for a rep with one order per lead', async () => {
    // The symptom that exposed the fan-out. Conversion is delivered orders over
    // leads assigned, so it CAN legitimately exceed 1 when a rep books several
    // orders against one lead — but not on the seeded fixture, where it is at most
    // one order per lead.
    await service.run(admin, today);

    const { rows } = await pool.query<{ full_name: string; conversion_pct: string }>(
      `SELECT e.full_name, s.conversion_pct::text
         FROM employee_score_daily s JOIN employee e ON e.employee_id = s.employee_id
        WHERE s.score_date = $1`,
      [today],
    );

    for (const row of rows) {
      expect(
        Number(row.conversion_pct) <= 1,
        `${row.full_name} scored a conversion rate of ${row.conversion_pct}`,
      ).toBe(true);
    }
  });

  it('records exactly the delivered and returned orders the order table holds', async () => {
    await service.run(admin, today);

    // Recomputed independently of the scoring query, straight from `order`, with
    // no ledger join at all — so a fan-out reintroduced on either side diverges.
    const { rows } = await pool.query<{
      employee_id: string; delivered: string; rto: string; leads: string;
      stored_conversion: string; stored_rto: string;
    }>(
      `WITH truth AS (
         SELECT o.booked_by_employee_id AS employee_id,
                count(*) FILTER (WHERE o.current_status = 'DELIVERED')::text AS delivered,
                count(*) FILTER (WHERE o.current_status IN ('RTO','RETURNED'))::text AS rto
           FROM "order" o
          WHERE o.booked_by_employee_id IS NOT NULL
            -- Mirrors EES's own scope. It reaches the lead source by joining the
            -- lead table, so an order with no lead is invisible to scoring
            -- (D-165) -- a documented gap, not a fan-out. Counting those here
            -- would fail this guard for the wrong reason and hide the one it
            -- exists for. (No backticks: this SQL sits in a JS template literal.)
            AND o.lead_id IS NOT NULL
            AND date_trunc('month', coalesce(o.delivered_date, o.rto_date))
                = date_trunc('month', $1::date)
          GROUP BY o.booked_by_employee_id
       )
       SELECT t.employee_id, t.delivered, t.rto,
              s.leads_assigned::text AS leads,
              s.conversion_pct::text AS stored_conversion,
              s.rto_pct::text        AS stored_rto
         FROM truth t
         JOIN employee_score_daily s
           ON s.employee_id = t.employee_id AND s.score_date = $1`,
      [today],
    );

    expect(rows.length).toBeGreaterThan(0);

    for (const r of rows) {
      const delivered = Number(r.delivered);
      const rto = Number(r.rto);
      const shipped = delivered + rto;

      expect(Number(r.stored_conversion)).toBeCloseTo(delivered / Number(r.leads), 4);
      expect(Number(r.stored_rto)).toBeCloseTo(shipped === 0 ? 0 : rto / shipped, 4);
    }
  });

  it('stores what the rep DID, not the shrunk figure used for ranking', async () => {
    // A rep with no returns must read 0.0000, whatever the team's RTO rate is.
    // Storing the neutralised value here recorded a spotless rep at 0.2182,
    // because shrinkage had pulled her toward a mean containing someone else's
    // return. Correct as a ranking input, false as a fact.
    const { rows } = await pool.query<{ full_name: string; rto_pct: string }>(
      `SELECT e.full_name, s.rto_pct::text
         FROM employee_score_daily s
         JOIN employee e ON e.employee_id = s.employee_id
        WHERE s.score_date = $1
          AND NOT EXISTS (
            SELECT 1 FROM "order" o
             WHERE o.booked_by_employee_id = s.employee_id
               AND o.current_status IN ('RTO','RETURNED')
               AND o.lead_id IS NOT NULL
               AND date_trunc('month', o.rto_date) = date_trunc('month', $1::date)
          )`,
      [today],
    );

    for (const r of rows) {
      expect(Number(r.rto_pct), `${r.full_name} has no returns but reads ${r.rto_pct}`).toBe(0);
    }
  });
});
