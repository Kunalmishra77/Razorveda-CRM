import pg from 'pg';
import { assertLocalTarget, requireDatabaseUrl } from './env.js';

/**
 * Generate the client's real volume, so the SLA can be MEASURED rather than
 * assumed (Phase 4 criterion 4, Phase 5 criterion 4).
 *
 * Every timing in this project so far has been taken on the dev fixture — a few
 * hundred rows — and every report of it has carried the same caveat: re-measure
 * at volume. This is that.
 *
 *   npm run db:seed:volume -- --days 90
 *
 * SHAPE, not just size. 180,000 identical rows would compress, index and refresh
 * far better than the real thing, and would prove nothing. So:
 *
 *   - ~2,000 orders a day across 9 sources with different conversion rates
 *   - a realistic status mix: most deliver, ~15% RTO, some stuck mid-flight
 *   - every order carries its full append-only event chain, because the certified
 *     views read the EVENT LOG rather than current_status (D-161) and the event
 *     table is therefore the one that actually gets large
 *   - ledger entries for delivered and returned orders
 *   - activity rows, because the KPI view counts them
 *
 * LOCAL ONLY. Runs through the same D-17 guard as every other destructive script.
 */

const BATCH = 2_000;

interface Options {
  readonly days: number;
  readonly ordersPerDay: number;
}

function parseOptions(): Options {
  const arg = (name: string, fallback: number): number => {
    const i = process.argv.indexOf(`--${name}`);
    if (i === -1) return fallback;
    const value = Number(process.argv[i + 1]);
    return Number.isFinite(value) && value > 0 ? value : fallback;
  };
  return { days: arg('days', 90), ordersPerDay: arg('orders', 2_000) };
}

/**
 * Deterministic pseudo-random.
 *
 * `Math.random()` would make two runs incomparable, and the whole point is to
 * measure the same shape twice — before and after a change.
 */
function rng(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state * 1_664_525 + 1_013_904_223) >>> 0;
    return state / 4_294_967_296;
  };
}

async function main(): Promise<void> {
  const target = requireDatabaseUrl();
  assertLocalTarget(target, 'seed:volume (writes hundreds of thousands of rows)');

  const { days, ordersPerDay } = parseOptions();
  const client = new pg.Client({ connectionString: target.url });
  client.on('error', () => undefined);
  await client.connect();

  const started = Date.now();
  console.log(`volume seed: ${days} days x ${ordersPerDay} orders/day = ${(days * ordersPerDay).toLocaleString()} orders`);

  try {
    const { rows: employees } = await client.query<{ employee_id: string }>(
      `SELECT employee_id FROM employee WHERE status = 'ACTIVE' ORDER BY emp_code`,
    );
    const { rows: sources } = await client.query<{ source_id: string }>(
      `SELECT source_id FROM lead_source ORDER BY code`,
    );
    const { rows: skus } = await client.query<{ sku_id: string; mrp: string }>(
      `SELECT sku_id, mrp::text FROM sku WHERE is_active ORDER BY sku_code`,
    );
    if (employees.length === 0 || sources.length === 0 || skus.length === 0) {
      throw new Error('Run db:seed and db:seed:dev first — this needs employees, sources and SKUs.');
    }

    const random = rng(20260822);
    const pick = <T>(xs: readonly T[]): T => xs[Math.floor(random() * xs.length)]!;

    let customers = 0;
    let orders = 0;
    let events = 0;

    for (let day = days; day >= 1; day -= 1) {
      const date = `CURRENT_DATE - ${day}`;

      // Customers in bulk. ~70% of orders come from a new customer and 30% from a
      // repeat buyer, which is what makes the repeat engine and Buyer Fq
      // meaningful rather than uniform.
      const newCustomers = Math.floor(ordersPerDay * 0.7);
      const { rows: made } = await client.query<{ customer_id: string }>(
        `INSERT INTO customer (primary_phone, full_name, city, state, pincode)
         SELECT '9' || lpad((floor(random() * 900000000) + 100000000)::text, 9, '0'),
                'Customer ' || g,
                (ARRAY['Pune','Mumbai','Nagpur','Indore','Jaipur','Lucknow','Surat'])[1 + (g % 7)],
                (ARRAY['MH','MH','MH','MP','RJ','UP','GJ'])[1 + (g % 7)],
                lpad((110000 + (g % 700000))::text, 6, '0')
           FROM generate_series(1, $1) g
         ON CONFLICT (primary_phone) DO NOTHING
         RETURNING customer_id`,
        [newCustomers],
      );
      customers += made.length;

      // Reuse earlier customers for the repeat share.
      const { rows: repeats } = await client.query<{ customer_id: string }>(
        `SELECT customer_id FROM customer ORDER BY random() LIMIT $1`,
        [ordersPerDay - made.length],
      );
      const dayCustomers = [...made, ...repeats];
      if (dayCustomers.length === 0) continue;

      // Leads, one per order, assigned round-robin. `assigned_at` is spread
      // across the day so the untouched-lead rules have something to bite on.
      const leadValues = dayCustomers.map((c, i) =>
        `('${c.customer_id}','${pick(sources).source_id}','${employees[i % employees.length]!.employee_id}',` +
        `${date} + interval '${8 + (i % 10)} hours', ${date} + interval '${7 + (i % 10)} hours',` +
        `${date} + 30)`,
      );
      const { rows: leads } = await client.query<{ lead_id: string }>(
        `INSERT INTO lead (customer_id, source_id, assigned_to, assigned_at, received_at, valid_till)
         VALUES ${leadValues.join(',')} RETURNING lead_id`,
      );

      // Orders. Status is drawn from a realistic mix rather than all-delivered:
      // an all-delivered dataset makes RTO% zero and every delivery-quality band
      // untested.
      const orderRows: string[] = [];
      for (let i = 0; i < leads.length; i += 1) {
        const roll = random();
        const status = roll < 0.70 ? 'DELIVERED' : roll < 0.85 ? 'RTO' : roll < 0.92 ? 'IN_TRANSIT' : 'PENDING';
        const sku = pick(skus);
        const value = (Number(sku.mrp) * (1 + Math.floor(random() * 3))).toFixed(2);
        const prepaid = random() < 0.35 ? (Number(value) * 0.3).toFixed(2) : '0.00';
        const cod = (Number(value) - Number(prepaid)).toFixed(2);
        const mode = Number(prepaid) === 0 ? 'COD' : 'PARTIAL_PREPAID';
        orderRows.push(
          `('VOL-${day}-${i}','${dayCustomers[i]!.customer_id}','${leads[i]!.lead_id}',` +
          `'${pick(sources).source_id}','${employees[i % employees.length]!.employee_id}',` +
          `${date}, ${value}, 0, '${mode}', ${prepaid}, ${cod}, '${status}',` +
          `${status === 'DELIVERED' || status === 'RTO' ? `${date} + 3` : 'NULL'},` +
          `${status === 'RTO' ? `${date} + 5` : 'NULL'})`,
        );
      }

      for (let i = 0; i < orderRows.length; i += BATCH) {
        const { rows: made2 } = await client.query<{ order_id: string; current_status: string }>(
          `INSERT INTO "order" (order_number, customer_id, lead_id, source_id, booked_by_employee_id,
                                order_date, final_value, company_base_value, payment_mode,
                                prepaid_amount, cod_amount, current_status, delivered_date, rto_date)
           VALUES ${orderRows.slice(i, i + BATCH).join(',')}
           ON CONFLICT (order_number) DO NOTHING
           RETURNING order_id, current_status::text`,
        );
        orders += made2.length;

        // The event chain. This is the table the certified views actually read,
        // and at five events per order it becomes the largest in the database —
        // which is exactly the thing worth measuring.
        const chain: Record<string, string[]> = {
          DELIVERED: ['PENDING', 'CONFIRMED', 'PROCESSING', 'DISPATCHED', 'OFD', 'DELIVERED'],
          RTO: ['PENDING', 'CONFIRMED', 'PROCESSING', 'DISPATCHED', 'OFD', 'RTO'],
          IN_TRANSIT: ['PENDING', 'CONFIRMED', 'PROCESSING', 'DISPATCHED', 'IN_TRANSIT'],
          PENDING: ['PENDING'],
        };
        const eventRows: string[] = [];
        const ledgerRows: string[] = [];
        for (const o of made2) {
          const path = chain[o.current_status] ?? ['PENDING'];
          path.forEach((to, step) => {
            eventRows.push(
              `('${o.order_id}',${step === 0 ? 'NULL' : `'${path[step - 1]}'`},'${to}','VOLUME',` +
              `${date} + interval '${step} days')`,
            );
          });
          if (o.current_status === 'DELIVERED' || o.current_status === 'RTO') {
            ledgerRows.push(`('${o.order_id}','${employees[0]!.employee_id}','REALISED_CREDIT',0,1000,'VOLUME',true,to_char(CURRENT_DATE - ${day},'YYYY-MM'))`);
          }
        }
        for (let j = 0; j < eventRows.length; j += BATCH) {
          await client.query(
            `INSERT INTO order_status_event (order_id, from_status, to_status, source, event_at)
             VALUES ${eventRows.slice(j, j + BATCH).join(',')}`,
          );
        }
        events += eventRows.length;
        for (let j = 0; j < ledgerRows.length; j += BATCH) {
          await client.query(
            `INSERT INTO attribution_ledger (order_id, employee_id, entry_type, company_base_value,
                                             employee_credited_value, rule_applied, is_realised, period_key)
             VALUES ${ledgerRows.slice(j, j + BATCH).join(',')}`,
          );
        }
      }

      // Activity on ~60% of leads, because the KPI view counts touched leads and
      // an untouched dataset makes every discipline metric identical.
      await client.query(
        `INSERT INTO activity (lead_id, customer_id, employee_id, type, connected, occurred_at)
         SELECT l.lead_id, l.customer_id, l.assigned_to, 'CALL', random() < 0.55,
                l.assigned_at + interval '2 hours'
           FROM lead l
          WHERE l.assigned_at::date = (${date})::date AND random() < 0.6`,
      );

      if (day % 15 === 0 || day === 1) {
        console.log(`   day -${day}: ${orders.toLocaleString()} orders, ${events.toLocaleString()} events so far`);
      }
    }

    console.log(`\n   ${customers.toLocaleString()} customers, ${orders.toLocaleString()} orders, ${events.toLocaleString()} status events`);
    console.log('   ANALYZE...');
    await client.query('ANALYZE');
    console.log(`volume seed: ok in ${((Date.now() - started) / 1000).toFixed(1)}s`);
  } finally {
    await client.end();
  }
}

main().catch((e: unknown) => {
  console.error(`\nvolume seed failed:\n${(e as Error).message}\n`);
  process.exitCode = 1;
});
