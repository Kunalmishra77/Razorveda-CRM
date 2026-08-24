import pg from 'pg';
import { assertLocalTarget, requireDatabaseUrl } from './env.js';
import { assertLocalDevDatabase } from './sentinel.js';

/**
 * Development fixture: cross-rep data so the RLS isolation suite has something to
 * isolate.
 *
 * Separate from `db:seed` on purpose. `db:seed` loads MASTER data — the things
 * that are true about the business. This loads pretend customers and leads, which
 * must never reach anything resembling production. Both guards apply.
 *
 * The isolation tests need at least two reps holding different leads, and at
 * least one customer belonging to neither. Without cross-rep data every isolation
 * assertion passes vacuously: a rep who can see nothing looks exactly like a rep
 * who is correctly scoped.
 */

const REP_A_LEADS = 3;
const REP_B_LEADS = 2;
const POOL_LEADS = 1;

async function main(): Promise<void> {
  const target = requireDatabaseUrl();
  assertLocalTarget(target, 'seed:dev (fixture data — never production)');

  const c = new pg.Client({ connectionString: target.url });
  await c.connect();

  try {
    await assertLocalDevDatabase(c, 'seed:dev');
    await c.query('BEGIN');

    const { rows: reps } = await c.query<{ employee_id: string; full_name: string }>(
      `SELECT e.employee_id, e.full_name
         FROM employee e JOIN app_user u ON u.user_id = e.user_id
        WHERE u.role = 'EMPLOYEE' AND e.status = 'ACTIVE'
        AND e.emp_code LIKE 'EMP-%'
      ORDER BY e.emp_code LIMIT 2`,
    );
    if (reps.length < 2) throw new Error('need 2 active employees — run db:seed first');
    const [a, b] = reps as [{ employee_id: string; full_name: string }, { employee_id: string; full_name: string }];

    const { rows: [source] } = await c.query<{ source_id: string }>(
      `SELECT source_id FROM lead_source WHERE code = 'SHOPIFY'`,
    );
    const { rows: [ringing] } = await c.query<{ disposition_id: string }>(
      `SELECT disposition_id FROM disposition WHERE code = 'RINGING'`,
    );
    if (!source || !ringing) throw new Error('masters missing — run db:seed first');

    const plan: Array<[string, string, string | null]> = [
      ...Array.from({ length: REP_A_LEADS }, (_, i): [string, string, string | null] => [
        `98765${String(10001 + i).padStart(5, '0')}`, `${a.full_name} Customer ${i + 1}`, a.employee_id,
      ]),
      ...Array.from({ length: REP_B_LEADS }, (_, i): [string, string, string | null] => [
        `98765${String(20001 + i).padStart(5, '0')}`, `${b.full_name} Customer ${i + 1}`, b.employee_id,
      ]),
      ...Array.from({ length: POOL_LEADS }, (_, i): [string, string, string | null] => [
        `98765${String(30001 + i).padStart(5, '0')}`, `Pool Customer ${i + 1}`, null,
      ]),
    ];

    for (const [phone, name, employeeId] of plan) {
      const { rows: [cust] } = await c.query<{ customer_id: string }>(
        `INSERT INTO customer (primary_phone, full_name, state, pincode)
         VALUES ($1,$2,'Uttar Pradesh','201013')
         ON CONFLICT (primary_phone) DO UPDATE SET full_name = EXCLUDED.full_name
         RETURNING customer_id`,
        [phone, name],
      );
      if (!cust) continue;

      // Two identifiers each, so customer_identifier has more rows than customer
      // and a leak there would be visible as a count mismatch rather than hidden.
      for (const [type, value] of [['MOBILE', phone], ['ALT_MOBILE', `98765${phone.slice(-5)}`]] as const) {
        await c.query(
          `INSERT INTO customer_identifier (customer_id, type, value, is_primary)
           VALUES ($1,$2::identifier_type,$3,$4)
           ON CONFLICT DO NOTHING`,
          [cust.customer_id, type, value, type === 'MOBILE'],
        );
      }

      await c.query(
        `INSERT INTO lead (customer_id, source_id, assigned_to, assigned_at, received_at)
         SELECT $1,$2,$3, CASE WHEN $3::uuid IS NULL THEN NULL ELSE now() END, now()
          WHERE NOT EXISTS (SELECT 1 FROM lead WHERE customer_id = $1)`,
        [cust.customer_id, source.source_id, employeeId],
      );
    }

    // One activity, so the append-only trigger has a row to refuse. A FOR EACH ROW
    // trigger cannot fire on an empty table — which briefly read as a failing
    // append-only check when it was really an empty fixture.
    const { rows: [lead] } = await c.query<{ lead_id: string; customer_id: string }>(
      `SELECT lead_id, customer_id FROM lead WHERE assigned_to = $1 LIMIT 1`,
      [a.employee_id],
    );
    if (lead) {
      await c.query(
        `INSERT INTO activity (lead_id, customer_id, employee_id, type, connected,
                               disposition_id, remark_raw)
         SELECT $1,$2,$3,'CALL',false,$4,'ringing, will try again'
          WHERE NOT EXISTS (SELECT 1 FROM activity WHERE lead_id = $1)`,
        [lead.lead_id, lead.customer_id, a.employee_id, ringing.disposition_id],
      );
    }

    // --- dev-only TOTP enrolment -----------------------------------------
    //
    // ADMIN and OWNER require 2FA, and evaluateLogin REFUSES an admin with no
    // enrolled secret rather than waving them through (D-52). Correct — but it
    // means a fresh install has nobody who can sign in.
    //
    // Production needs a real enrolment flow (scan a QR, confirm a code) and that
    // is still to build. For local development the admins get a KNOWN secret so
    // the console is reachable. This lives in seed:dev, never in the master seed,
    // and seed:dev is refused against anything but a marked local database.
    const DEV_TOTP_SECRET = 'GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ';
    const { rowCount: enrolled } = await c.query(
      `UPDATE app_user SET totp_secret = $1
        WHERE role IN ('ADMIN','OWNER') AND totp_secret IS NULL`,
      [DEV_TOTP_SECRET],
    );
    console.log(`   dev TOTP enrolled for ${enrolled ?? 0} admin/owner account(s)`);
    console.log(`   DEV ONLY secret: ${DEV_TOTP_SECRET}`);

    await c.query('COMMIT');
    console.log(`   ${a.full_name}: ${REP_A_LEADS} leads · ${b.full_name}: ${REP_B_LEADS} leads · pool: ${POOL_LEADS}`);
    console.log('seed:dev ok — fixture data, never for production');
  } catch (e) {
    await c.query('ROLLBACK');
    throw e;
  } finally {
    await c.end();
  }
}

main().catch((e: unknown) => {
  console.error(`\nseed:dev failed:\n${(e as Error).message}\n`);
  process.exitCode = 1;
});
