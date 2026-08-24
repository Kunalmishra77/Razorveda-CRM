import pg from 'pg';
import { requireDatabaseUrl, assertLocalTarget } from './env.js';

/**
 * A BELIEVABLE DAY FOR ONE REP.
 *
 *   npm run db:seed:demo
 *
 * WHY THIS EXISTS. The volume generator builds 180,000 orders to prove the
 * reports survive real load, and it is very good at that. It is useless for
 * showing anyone the product: every customer is called "Customer 412", nobody has
 * ever said anything, and every lead falls in the same band. Shown that screen,
 * the client could not tell what he was looking at — and he was right not to.
 * Fifty identical rows is not a worklist, it is a wall.
 *
 * A rep's screen only makes sense when the data has the SHAPE of a real day: a
 * couple of things she promised and has not done, a few due today, someone about
 * to run out of what she bought last month, some new names, and a tail of stuff
 * that has been sitting. Plus remarks — in the Hinglish the team actually writes
 * (CLAUDE.md section 6), because "call after 6, busy" is the entire difference
 * between a good second call and an irritating one.
 *
 * Local only, same guard as every other seed (D-17). Idempotent: it clears the
 * demo customers' open leads before rebuilding, so running it twice is safe.
 */

interface DemoLead {
  readonly name: string;
  readonly phone: string;
  readonly city: string;
  readonly state: string;
  /** Days from today. Negative = overdue, 0 = due today, null = no follow-up set. */
  readonly followupInDays: number | null;
  readonly source: string;
  readonly interest: string;
  readonly attempts: number;
  readonly remark: string | null;
  /** Days ago the last remark was written. */
  readonly remarkAgeDays: number;
  /** Delivered orders already to her name. */
  readonly pastOrders: number;
  /** Due to reorder — puts her in the repeat band. */
  readonly repeatDue: boolean;
}

/**
 * Written as a day, not as rows. Reading top to bottom should feel like the
 * morning it describes.
 */
const DAY: readonly DemoLead[] = [
  {
    name: 'Aditi Sharma', phone: '9873012480', city: 'Delhi', state: 'Delhi',
    followupInDays: -2, source: 'META_ADS', interest: 'Breast Care', attempts: 3,
    remark: 'bola tha Monday call karna, abhi busy hai', remarkAgeDays: 2,
    pastOrders: 0, repeatDue: false,
  },
  {
    name: 'Kavita Rane', phone: '9820551147', city: 'Mumbai', state: 'Maharashtra',
    followupInDays: -1, source: 'WEB_WHATSAPP', interest: 'Slimming Care', attempts: 2,
    remark: 'husband se puchh ke batayegi, price thoda zyada lag raha', remarkAgeDays: 1,
    pastOrders: 0, repeatDue: false,
  },
  {
    name: 'Sunita Verma', phone: '9945220318', city: 'Bengaluru', state: 'Karnataka',
    followupInDays: 0, source: 'SHOPIFY', interest: 'Hair Care', attempts: 1,
    remark: 'interested, aaj shaam 6 baje ke baad call karna', remarkAgeDays: 3,
    pastOrders: 1, repeatDue: false,
  },
  {
    name: 'Rekha Nair', phone: '9847116052', city: 'Kochi', state: 'Kerala',
    followupInDays: 0, source: 'WEB_CALL', interest: 'Skinwise', attempts: 2,
    remark: 'sample ke baare mein pucha, COD chahiye', remarkAgeDays: 4,
    pastOrders: 0, repeatDue: false,
  },
  {
    name: 'Priya Deshpande', phone: '9922440761', city: 'Pune', state: 'Maharashtra',
    followupInDays: null, source: 'DELIVERED_REPEAT', interest: 'Breast Care', attempts: 4,
    remark: 'pichli baar 2 bottle liye the, result acha bola', remarkAgeDays: 34,
    pastOrders: 2, repeatDue: true,
  },
  {
    name: 'Anjali Gupta', phone: '9711583264', city: 'Noida', state: 'Uttar Pradesh',
    followupInDays: null, source: 'DELIVERED_REPEAT', interest: 'Hair Care', attempts: 6,
    remark: 'regular customer, har month leti hai', remarkAgeDays: 29,
    pastOrders: 4, repeatDue: true,
  },
  {
    name: 'Meenakshi Iyer', phone: '9840227519', city: 'Chennai', state: 'Tamil Nadu',
    followupInDays: null, source: 'META_ADS', interest: 'Face Care', attempts: 0,
    remark: null, remarkAgeDays: 0, pastOrders: 0, repeatDue: false,
  },
  {
    name: 'Farhana Sheikh', phone: '9038117425', city: 'Kolkata', state: 'West Bengal',
    followupInDays: null, source: 'ADD_TO_CART', interest: 'Intimate Care', attempts: 0,
    remark: null, remarkAgeDays: 0, pastOrders: 0, repeatDue: false,
  },
  {
    name: 'Simran Kaur', phone: '9878334160', city: 'Ludhiana', state: 'Punjab',
    followupInDays: null, source: 'WA_CAMPAIGN', interest: 'Slimming Care', attempts: 0,
    remark: null, remarkAgeDays: 0, pastOrders: 0, repeatDue: false,
  },
  {
    name: 'Lakshmi Reddy', phone: '9963208814', city: 'Hyderabad', state: 'Telangana',
    followupInDays: null, source: 'RTO_RECOVERY', interest: 'Breast Care', attempts: 5,
    remark: 'parcel wapas aa gaya tha, address galat tha', remarkAgeDays: 11,
    pastOrders: 0, repeatDue: false,
  },
  {
    name: 'Neha Joshi', phone: '9829116703', city: 'Jaipur', state: 'Rajasthan',
    followupInDays: null, source: 'SHOPIFY', interest: 'Skinwise', attempts: 2,
    remark: 'phone uthaya nahi, WhatsApp pe message chhoda', remarkAgeDays: 9,
    pastOrders: 0, repeatDue: false,
  },
  {
    name: 'Pooja Bhatt', phone: '9426551028', city: 'Ahmedabad', state: 'Gujarat',
    followupInDays: null, source: 'NC_REFUSED', interest: 'Face Care', attempts: 3,
    remark: 'pehle mana kiya tha, ab dobara try karna hai', remarkAgeDays: 15,
    pastOrders: 0, repeatDue: false,
  },
] as const;

async function main(): Promise<void> {
  const target = requireDatabaseUrl();
  assertLocalTarget(target, 'seed:demo (creates pretend customers)');

  const client = new pg.Client({ connectionString: target.url });
  await client.connect();
  console.log(`-> ${target.user}@${target.host}:${target.port}/${target.database}`);

  try {
    await client.query('BEGIN');

    const { rows: [rep] } = await client.query<{ employee_id: string; full_name: string }>(
      `SELECT e.employee_id, e.full_name
         FROM employee e JOIN app_user u ON u.user_id = e.user_id
        WHERE u.role = 'EMPLOYEE' AND e.status = 'ACTIVE'
        ORDER BY e.emp_code LIMIT 1`,
    );
    if (!rep) throw new Error('No active rep. Run npm run db:seed first.');

    // Everything else this rep holds is pushed out of the way rather than
    // deleted — closing is what a rollback does too, because app_role has no
    // DELETE anywhere and the audit trail is worth more than tidy rows.
    const { rowCount: parked } = await client.query(
      `UPDATE lead SET closed_at = now()
        WHERE assigned_to = $1 AND closed_at IS NULL AND NOT is_converted`,
      [rep.employee_id],
    );

    let created = 0;
    for (const d of DAY) {
      const { rows: [customer] } = await client.query<{ customer_id: string }>(
        `INSERT INTO customer (full_name, primary_phone, city, state, owner_employee_id,
                               lifetime_orders, lifetime_value, customer_type, next_due_date)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8::customer_type,$9)
         ON CONFLICT (primary_phone) DO UPDATE SET
           full_name = EXCLUDED.full_name, city = EXCLUDED.city, state = EXCLUDED.state,
           owner_employee_id = EXCLUDED.owner_employee_id,
           lifetime_orders = EXCLUDED.lifetime_orders, lifetime_value = EXCLUDED.lifetime_value,
           customer_type = EXCLUDED.customer_type, next_due_date = EXCLUDED.next_due_date
         RETURNING customer_id`,
        [
          d.name, d.phone, d.city, d.state, rep.employee_id,
          d.pastOrders, String(d.pastOrders * 1499),
          d.pastOrders > 0 ? 'EXISTING' : 'NEW',
          d.repeatDue ? new Date().toISOString().slice(0, 10) : null,
        ],
      );
      const customerId = customer!.customer_id;

      await client.query(
        `UPDATE lead SET closed_at = now() WHERE customer_id = $1 AND closed_at IS NULL`,
        [customerId],
      );

      const { rows: [lead] } = await client.query<{ lead_id: string }>(
        `INSERT INTO lead (customer_id, source_id, assigned_to, assigned_at, received_at,
                           valid_till, temperature, product_interest, contact_attempts,
                           ever_connected, next_followup_at)
         SELECT $1, s.source_id, $2,
                now() - make_interval(days => $3::int),
                now() - make_interval(days => $3::int),
                (CURRENT_DATE + s.validity_days)::date,
                $4::lead_temperature, $5, $6, $7,
                CASE WHEN $8::int IS NULL THEN NULL
                     ELSE (CURRENT_DATE + $8::int)::timestamptz + interval '11 hours' END
           FROM lead_source s WHERE s.code = $9
         RETURNING lead_id`,
        [
          customerId, rep.employee_id,
          d.attempts > 0 ? Math.max(1, d.remarkAgeDays) : 0,
          d.attempts > 2 ? 'HOT' : d.attempts > 0 ? 'WARM' : 'COLD',
          d.interest, d.attempts, d.attempts > 0,
          d.followupInDays, d.source,
        ],
      );
      if (!lead) throw new Error(`lead_source ${d.source} is missing — run npm run db:seed`);

      if (d.remark) {
        await client.query(
          `INSERT INTO activity (lead_id, customer_id, employee_id, type, connected,
                                 remark_raw, occurred_at)
           VALUES ($1,$2,$3,'CALL',true,$4, now() - make_interval(days => $5::int))`,
          [lead.lead_id, customerId, rep.employee_id, d.remark, d.remarkAgeDays],
        );
      }
      created += 1;
    }

    await client.query('COMMIT');

    console.log(`   parked ${parked ?? 0} existing lead(s) for ${rep.full_name}`);
    console.log(`   ${created} demo leads: 2 overdue, 2 due today, 2 repeat, 3 new, 3 ageing`);
    console.log(`   remarks are Hinglish, as the team actually writes them`);
    console.log('seed:demo ok — pretend customers, never for production');
  } catch (e) {
    await client.query('ROLLBACK').catch(() => undefined);
    throw e;
  } finally {
    await client.end();
  }
}

main().catch((e: unknown) => {
  console.error(`\nseed:demo failed:\n${(e as Error).message}\n`);
  process.exitCode = 1;
});
