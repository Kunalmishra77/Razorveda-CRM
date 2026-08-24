import ExcelJS from 'exceljs';
import { fileURLToPath } from 'node:url';
import { existsSync } from 'node:fs';
import pg from 'pg';
import { requireDatabaseUrl, assertLocalTarget } from './env.js';

/**
 * Loads the client's four real workbooks into the local database.
 *
 *   npm run db:import:client
 *
 * WHY THIS EXISTS SEPARATELY FROM THE UPLOAD SCREEN.
 *
 * Production ingestion goes through the Upload Centre: map columns, validate,
 * preview, commit, with a rollback. That is the path an admin uses and it is
 * already built. This is a one-shot loader so the Employee Portal can be
 * demonstrated on the client's OWN data rather than on invented names, and it is
 * deliberately not wired into the app.
 *
 * WHAT IT HAS TO SURVIVE. These are the real files, and they carry every defect
 * docs/08 lists:
 *
 *   - Add to Cart: 21% of the Value column has been turned into a DATE by Excel
 *     (1902-06-17 instead of 949). Those rows keep the lead and drop the amount —
 *     a guessed price would be worse than a blank one.
 *   - Shopify: the sheet is shifted from `address` onward. `city` holds a street,
 *     `PinCode` holds a city, `Category` holds the PIN code. There are two caller
 *     columns and only the lowercase one has agent names in it.
 *   - Skinwise: `Alt No` holds "Hot", a URL, or a symptom note. Six columns were
 *     created and never filled.
 *   - Everywhere: one outcome spelled four ways, one agent spelled two ways.
 *
 * Nothing here guesses. A row that cannot be read honestly is skipped and counted,
 * and the counts are printed at the end.
 */

const txt = (v: unknown): string => {
  if (v === null || v === undefined) return '';
  if (v instanceof Date) return `DATE:${v.toISOString().slice(0, 10)}`;
  if (typeof v === 'object') {
    const o = v as Record<string, unknown>;
    if ('text' in o) return String(o['text']);
    if ('richText' in o) return (o['richText'] as { text: string }[]).map((t) => t.text).join('');
    if ('result' in o) return String(o['result'] ?? '');
    return '';
  }
  return String(v).trim();
};

const asDate = (s: string): string | null => (s.startsWith('DATE:') ? s.slice(5) : null);

/**
 * 10 digits starting 6–9, or nothing.
 *
 * The files contain `9876543210.0`, `+91…`, `0…`, an email address, and the
 * literal word `code`. CLAUDE.md section 6 is explicit: normalise or park the row.
 */
function phone(raw: string): string | null {
  const d = raw.replace(/\D/g, '');
  const ten = d.length > 10 ? d.slice(-10) : d;
  return /^[6-9]\d{9}$/.test(ten) ? ten : null;
}

/** Money that Excel turned into a date is not money. */
function money(raw: string): string | null {
  if (raw.startsWith('DATE:')) return null;
  const n = Number(raw.replace(/[^\d.]/g, ''));
  return Number.isFinite(n) && n > 0 && n < 1_000_000 ? n.toFixed(2) : null;
}

/** Names arrive with emoji and decorative unicode. Kept — they are real people. */
const cleanName = (raw: string): string | null => {
  const s = raw.replace(/\s+/g, ' ').trim();
  return s && s.length <= 120 ? s : null;
};

interface Ctx {
  client: pg.Client;
  dispositions: Map<string, string>;   // lowercased alias/label -> disposition_id
  sources: Map<string, string>;        // code -> source_id
  skus: { id: string; code: string; name: string }[];
  employees: Map<string, string>;      // lowercased name -> employee_id
}

const stats = {
  leads: 0, customers: 0, orders: 0, activities: 0,
  skippedNoPhone: 0, skippedNoName: 0, droppedAmount: 0, unknownDisposition: new Set<string>(),
};

/** Finds an employee by the name in the sheet, creating nothing. */
function employeeFor(ctx: Ctx, raw: string): string | null {
  const k = raw.trim().toLowerCase();
  if (!k || k === 'shopify' || k === 'new client' || k === 'user client') return null;
  return ctx.employees.get(k) ?? null;
}

function dispositionFor(ctx: Ctx, raw: string): string | null {
  const k = raw.trim().toLowerCase();
  if (!k) return null;
  const hit = ctx.dispositions.get(k);
  if (!hit) stats.unknownDisposition.add(raw.trim());
  return hit ?? null;
}

/** Best-effort SKU match on the product text. Null when nothing matches. */
function skuFor(ctx: Ctx, productText: string): string | null {
  const t = productText.toLowerCase();
  if (!t) return null;
  for (const s of ctx.skus) {
    const first = s.name.toLowerCase().split(/[\s,]/)[0] ?? '';
    if (first.length > 3 && t.includes(first)) return s.id;
  }
  if (/b-reduce|breduce/.test(t)) return ctx.skus.find((s) => /reduce/i.test(s.name))?.id ?? null;
  if (/mamo\s*plus/.test(t)) return ctx.skus.find((s) => /mamo/i.test(s.name))?.id ?? null;
  if (/geluslim|slimming/.test(t)) return ctx.skus.find((s) => /slim/i.test(s.name))?.id ?? null;
  if (/vg\s*tone|tightening/.test(t)) return ctx.skus.find((s) => /tone|tight/i.test(s.name))?.id ?? null;
  return null;
}

/** Upserts the customer on the phone number, which is the business key (rule 4). */
async function upsertCustomer(
  ctx: Ctx,
  // `| undefined` spelled out, because the project runs with
  // exactOptionalPropertyTypes and an omitted sheet column arrives as undefined.
  o: {
    phone: string; name: string | null;
    city?: string | undefined; state?: string | undefined;
    pin?: string | undefined; owner?: string | null | undefined;
  },
): Promise<string> {
  const { rows: [r] } = await ctx.client.query<{ customer_id: string; existed: boolean }>(
    `INSERT INTO customer (full_name, primary_phone, city, state, pincode, owner_employee_id)
     VALUES ($1,$2,$3,$4,$5,$6)
     ON CONFLICT (primary_phone) DO UPDATE SET
       full_name = coalesce(EXCLUDED.full_name, customer.full_name),
       city      = coalesce(EXCLUDED.city, customer.city),
       state     = coalesce(EXCLUDED.state, customer.state),
       pincode   = coalesce(EXCLUDED.pincode, customer.pincode),
       owner_employee_id = coalesce(customer.owner_employee_id, EXCLUDED.owner_employee_id)
     RETURNING customer_id, (xmax <> 0) AS existed`,
    [o.name, o.phone, o.city ?? null, o.state ?? null, o.pin?.replace(/\D/g, '').slice(0, 6) || null, o.owner ?? null],
  );
  if (!r!.existed) stats.customers += 1;
  return r!.customer_id;
}

async function readSheet(file: string, name: string): Promise<Record<string, string>[]> {
  const wb = new ExcelJS.Workbook();
  await wb.xlsx.readFile(file);
  const ws = wb.getWorksheet(name);
  if (!ws) return [];
  const hdr = (ws.getRow(1).values as unknown[] ?? []).slice(1).map(txt);
  const out: Record<string, string>[] = [];
  const last = ws.actualRowCount ?? ws.rowCount;
  for (let r = 2; r <= last; r += 1) {
    const vals = (ws.getRow(r).values as unknown[] ?? []).slice(1).map(txt);
    if (vals.every((v) => v === '')) continue;
    const o: Record<string, string> = {};
    hdr.forEach((h, i) => { if (h) o[h] = vals[i] ?? ''; });
    out.push(o);
  }
  return out;
}

/* ------------------------------------------------------------------ */
/* Add to Cart — the calling sheet. One row per lead, with its outcome. */
/* ------------------------------------------------------------------ */
async function importAddToCart(ctx: Ctx, dir: string, limit: number): Promise<void> {
  const rows = (await readSheet(`${dir}/Add to Cart.xlsx`, 'Data')).slice(0, limit);
  const sourceId = ctx.sources.get('ADD_TO_CART')!;
  console.log(`\n   Add to Cart: ${rows.length} rows`);

  for (const r of rows) {
    const p = phone(r['Phone'] ?? '');
    if (!p) { stats.skippedNoPhone += 1; continue; }
    const name = cleanName(r['Shipping Name'] ?? '');
    if (!name) { stats.skippedNoName += 1; continue; }

    const agent = employeeFor(ctx, r['Caller Name'] ?? '');
    const value = money(r['Value'] ?? '');
    if (!value && (r['Value'] ?? '').startsWith('DATE:')) stats.droppedAmount += 1;

    const customerId = await upsertCustomer(ctx, {
      phone: p, name,
      city: r['Billing City'] || undefined,
      pin: r['Billing Zip'] || undefined,
    });

    const dispId = dispositionFor(ctx, r['Status'] ?? '');
    const received = asDate(r['Date'] ?? '') ?? '2023-01-01';
    const called = asDate(r['Calling Date'] ?? '');
    // Their Remark packs several attempts into one cell — "ringing/ringing/call
    // back". Each slash is a separate attempt, which is exactly what this system
    // stores as separate rows.
    const parts = (r['Remark'] ?? '').split('/').map((s) => s.trim()).filter(Boolean);
    const attempts = Math.max(parts.length, called ? 1 : 0);

    const { rows: [lead] } = await ctx.client.query<{ lead_id: string }>(
      `INSERT INTO lead (customer_id, source_id, assigned_to, assigned_at, received_at,
                         valid_till, product_interest, contact_attempts, ever_connected,
                         current_disposition_id, predicted_value, temperature)
       VALUES ($1,$2,$3,$4::date,$4::date,($4::date + 30),$5,$6,$7,$8,$9,
               CASE WHEN $6::int >= 3 THEN 'HOT' WHEN $6::int >= 1 THEN 'WARM' ELSE 'COLD' END::lead_temperature)
       RETURNING lead_id`,
      [customerId, sourceId, agent, received, (r['Lineitem name'] ?? '').slice(0, 120),
        attempts, /cd/i.test(r['CD/ND'] ?? ''), dispId, value],
    );
    stats.leads += 1;

    // One activity per attempt, in order, so the history reads like the day it was.
    for (let i = 0; i < parts.length; i += 1) {
      await ctx.client.query(
        `INSERT INTO activity (lead_id, customer_id, employee_id, type, connected,
                               disposition_id, remark_raw, occurred_at)
         VALUES ($1,$2,$3,'CALL',$4,$5,$6, ($7::date + make_interval(hours => $8::int)))`,
        [lead!.lead_id, customerId, agent, /cd/i.test(r['CD/ND'] ?? ''),
          i === parts.length - 1 ? dispId : null, parts[i], called ?? received, 10 + i],
      );
      stats.activities += 1;
    }
  }
}

/* ------------------------------------------------------------- */
/* Skinwise — Meta Ads leads, with connectivity/relevance flags.  */
/* ------------------------------------------------------------- */
async function importSkinwise(ctx: Ctx, dir: string): Promise<void> {
  const rows = await readSheet(`${dir}/Skinwise Meta Ad Report.xlsx`, 'Data');
  const sourceId = ctx.sources.get('META_ADS')!;
  console.log(`   Skinwise Meta: ${rows.length} rows`);

  for (const r of rows) {
    const p = phone(r['Number'] ?? '');
    if (!p) { stats.skippedNoPhone += 1; continue; }
    const name = cleanName(r['Customer Name'] ?? '') ?? 'Name not recorded';

    const agent = employeeFor(ctx, r['Agent Name'] ?? '');
    const customerId = await upsertCustomer(ctx, { phone: p, name });
    const dispId = dispositionFor(ctx, r['status'] ?? '');
    const received = asDate(r['Date'] ?? '') ?? '2026-08-12';
    const connected = /^yes$/i.test(r['Connectivity'] ?? '');

    // "Hot" turns up in the Alt No column. It is a lead temperature that ended up
    // in a phone field, and it is worth keeping rather than discarding.
    const alt = (r['Alt No'] ?? '').trim();
    const temp = /^hot$/i.test(alt) ? 'HOT' : connected ? 'WARM' : 'COLD';

    const { rows: [lead] } = await ctx.client.query<{ lead_id: string }>(
      `INSERT INTO lead (customer_id, source_id, assigned_to, assigned_at, received_at,
                         valid_till, product_interest, contact_attempts, ever_connected,
                         current_disposition_id, temperature)
       VALUES ($1,$2,$3,$4::date,$4::date,($4::date + 21),'Skinwise',1,$5,$6,$7::lead_temperature)
       RETURNING lead_id`,
      [customerId, sourceId, agent, received, connected, dispId, temp],
    );
    stats.leads += 1;

    const note = [
      r['Relevance'] && !/^yes$/i.test(r['Relevance']) ? 'not a relevant lead' : '',
      alt && !/^hot$/i.test(alt) && !/^\d+$/.test(alt) ? alt : '',
    ].filter(Boolean).join(' · ');

    await ctx.client.query(
      `INSERT INTO activity (lead_id, customer_id, employee_id, type, connected,
                             disposition_id, remark_raw, occurred_at)
       VALUES ($1,$2,$3,'CALL',$4,$5,$6,($7::date + interval '11 hours'))`,
      [lead!.lead_id, customerId, agent, connected, dispId, note || null, received],
    );
    stats.activities += 1;
  }
}

/* ---------------------------------------------------------------------- */
/* Shopify — orders an agent upgraded. The attribution file (F7).          */
/* ---------------------------------------------------------------------- */
async function importShopify(ctx: Ctx, dir: string): Promise<void> {
  const rows = await readSheet(`${dir}/Shopify Upgraded & Confirmed Sales Report 2026.xlsm`, 'Data');
  const sourceId = ctx.sources.get('SHOPIFY')!;
  console.log(`   Shopify upgraded: ${rows.length} rows`);

  for (const r of rows) {
    const p = phone(r['Phoneno'] ?? '');
    if (!p) { stats.skippedNoPhone += 1; continue; }
    const name = cleanName(r['Name'] ?? '');
    if (!name) { stats.skippedNoName += 1; continue; }

    // THE COLUMN SHIFT. `caller name` (lowercase) holds the agent; `CallerName`
    // holds "New Client". `PinCode` holds the city and `Category` holds the PIN.
    const agent = employeeFor(ctx, r['caller name'] ?? '');
    const city = (r['PinCode'] ?? '').trim();
    const pin = (r['Category'] ?? '').replace(/\D/g, '');

    const customerId = await upsertCustomer(ctx, { phone: p, name, city, pin, owner: agent });

    const base = money(r['Amount'] ?? '');
    const upgrade = money(r['Upgrade Amt'] ?? '');
    const status = (r['Shopify Status'] ?? '').trim().toLowerCase();
    const orderDate = asDate(r['Date'] ?? '') ?? '2026-08-01';
    if (!base) continue;

    // The order lands as a lead first, so the rep's work on it is visible in the
    // portal the same way every other source is.
    //
    // ONE LEAD PER ARRIVAL, NOT PER SHEET ROW. A Shopify export carries a row per
    // LINE ITEM, so a customer who bought two products is on the sheet twice. The
    // order below already collapses those with ON CONFLICT (order_number), and
    // the lead did not — which produced a second lead with no order, no activity
    // and no way to tell it from a real one. 28 of them, and on the admin's
    // reassignment screen they showed as the same customer listed twice.
    //
    // A lead is "one instance of a customer arriving from a source" (CLAUDE.md
    // section 5). Two line items is one arrival. The same customer ordering on a
    // DIFFERENT date is a genuine second arrival, so the date stays in the key.
    const { rows: [lead] } = await ctx.client.query<{ lead_id: string }>(
      `WITH existing AS (
         SELECT lead_id FROM lead
          WHERE customer_id = $1 AND source_id = $2 AND received_at::date = $4::date
          LIMIT 1
       ), ins AS (
         INSERT INTO lead (customer_id, source_id, assigned_to, assigned_at, received_at,
                           valid_till, product_interest, contact_attempts, ever_connected,
                           is_converted, temperature)
         SELECT $1,$2,$3,$4::date,$4::date,($4::date + 14),$5,1,true,
                $6, 'HOT'::lead_temperature
          WHERE NOT EXISTS (SELECT 1 FROM existing)
         RETURNING lead_id
       )
       SELECT lead_id, true AS created FROM ins
       UNION ALL
       SELECT lead_id, false AS created FROM existing
       LIMIT 1`,
      [customerId, sourceId, agent, orderDate, (r['ProductDeatil'] ?? '').slice(0, 120),
        status === 'delivered'],
    );
    if (!lead) continue;
    if ((lead as { created?: boolean }).created !== false) stats.leads += 1;

    const total = (Number(base) + Number(upgrade ?? 0)).toFixed(2);
    const current = status === 'delivered' ? 'DELIVERED'
      : status === 'rto' ? 'RTO'
      : status === 'refused' ? 'CANCELLED'
      : status === 'in transit' ? 'DISPATCHED' : 'PENDING';

    const written = await ctx.client.query(
      `INSERT INTO "order" (order_number, customer_id, lead_id, source_id, order_date,
                            final_value, company_base_value, booked_by_employee_id,
                            current_status, ship_state, ship_pincode, delivered_date)
       VALUES ($1,$2,$3,$4,$5::date,$6,$7,$8,$9::order_status,$10,$11,$12)
       ON CONFLICT (order_number) DO NOTHING`,
      [`SHOP-${p}-${orderDate}`, customerId, lead.lead_id, sourceId, orderDate,
        total,
        // The base value is what the customer had already committed on Shopify.
        // Only the upgrade is the rep's (F7) — this file is the client's own proof
        // that they already think this way.
        base, agent, current, city || null, pin || null,
        current === 'DELIVERED' ? orderDate : null],
    );
    // Count what was WRITTEN, not what was attempted. ON CONFLICT DO NOTHING makes
    // a duplicate row a no-op, and the old `+= 1` counted it anyway — so the
    // import's own summary reported more orders than it had created, which is the
    // one number nobody would think to check.
    stats.orders += written.rowCount ?? 0;
  }
}

/* ------------------------------------------------------------------ */
/* User Data / Sheet1 — the delivered history. This is "Delivered Data" */
/* the admin assigns for repeat calling.                               */
/* ------------------------------------------------------------------ */
async function importDelivered(ctx: Ctx, dir: string, limit: number): Promise<void> {
  const rows = (await readSheet(`${dir}/User Data.xlsx`, 'Sheet1')).slice(0, limit);
  const sourceId = ctx.sources.get('DELIVERED_REPEAT')!;
  console.log(`   User Data (delivered history): ${rows.length} rows`);

  for (const r of rows) {
    const p = phone(r['Number'] ?? '');
    if (!p) { stats.skippedNoPhone += 1; continue; }
    const name = cleanName(r['Customer Name'] ?? '');
    if (!name) { stats.skippedNoName += 1; continue; }

    const agent = employeeFor(ctx, r['Agent Name'] ?? '');
    const amount = money(r['Amount'] ?? '');
    const status = (r['status'] ?? '').trim().toLowerCase();
    const orderDate = asDate(r['Date'] ?? '') ?? '2026-01-01';
    const deliveredOn = asDate(r['Deliverd date'] ?? '');

    const customerId = await upsertCustomer(ctx, {
      phone: p, name,
      city: r['city'] || undefined,
      pin: r['Pin code'] || undefined,
      owner: agent,
    });
    if (!amount) continue;

    const current = status === 'delivered' ? 'DELIVERED'
      : status === 'rto' ? 'RTO'
      : status === 'refused' ? 'CANCELLED'
      : status === 'in transit' ? 'DISPATCHED' : 'PENDING';

    await ctx.client.query(
      `INSERT INTO "order" (order_number, customer_id, source_id, order_date, final_value,
                            booked_by_employee_id, current_status, ship_state, ship_pincode,
                            delivered_date, courier_partner, awb_number, payment_mode)
       VALUES ($1,$2,$3,$4::date,$5,$6,$7::order_status,$8,$9,$10,$11,$12,
               CASE WHEN $13 ILIKE '%prepaid%' OR $13 ILIKE '%web%' THEN 'PREPAID'
                    ELSE 'COD' END::payment_mode)
       ON CONFLICT (order_number) DO NOTHING`,
      [`UD-${r['Awbs'] || p}-${orderDate}`, customerId, sourceId, orderDate, amount,
        agent, current, (r['city'] ?? '').slice(0, 60) || null,
        (r['Pin code'] ?? '').replace(/\D/g, '').slice(0, 6) || null,
        current === 'DELIVERED' ? (deliveredOn ?? orderDate) : null,
        (r['Courier Servive'] ?? '').startsWith('DATE:') ? null : (r['Courier Servive'] || null),
        String(r['Awbs'] ?? '').slice(0, 40) || null,
        r['payment mode'] ?? ''],
    );
    stats.orders += 1;
  }

  // Derived, never uploaded (docs/02): lifetime counts come from the orders.
  await ctx.client.query(
    `UPDATE customer c SET
       lifetime_orders = t.n, lifetime_value = t.v,
       first_order_date = t.first, last_order_date = t.last,
       customer_type = CASE WHEN t.n > 0 THEN 'EXISTING' ELSE 'NEW' END::customer_type
     FROM (
       SELECT customer_id,
              count(*) FILTER (WHERE current_status = 'DELIVERED') AS n,
              coalesce(sum(final_value) FILTER (WHERE current_status = 'DELIVERED'),0) AS v,
              min(order_date) FILTER (WHERE current_status = 'DELIVERED') AS first,
              max(order_date) FILTER (WHERE current_status = 'DELIVERED') AS last
         FROM "order" GROUP BY customer_id
     ) t
    WHERE t.customer_id = c.customer_id`,
  );
}

async function main(): Promise<void> {
  const target = requireDatabaseUrl();
  assertLocalTarget(target, 'import:client (loads the client workbooks)');

  const dir = fileURLToPath(new URL('../../../test-data', import.meta.url));
  if (!existsSync(dir)) throw new Error(`test-data not found at ${dir}`);

  const limit = Number(process.env['IMPORT_LIMIT'] ?? '1200');
  const client = new pg.Client({ connectionString: target.url });
  await client.connect();
  console.log(`-> ${target.user}@${target.host}:${target.port}/${target.database}`);
  console.log(`   reading ${dir}`);

  try {
    const ctx: Ctx = {
      client,
      dispositions: new Map(),
      sources: new Map(),
      skus: [],
      employees: new Map(),
    };

    for (const d of (await client.query<{ disposition_id: string; label: string }>(
      'SELECT disposition_id, label FROM disposition')).rows) {
      ctx.dispositions.set(d.label.toLowerCase(), d.disposition_id);
    }
    for (const a of (await client.query<{ alias: string; disposition_id: string }>(
      `SELECT a.alias, d.disposition_id FROM disposition_alias a
         JOIN disposition d ON d.disposition_id = a.disposition_id`)).rows) {
      ctx.dispositions.set(a.alias.toLowerCase(), a.disposition_id);
    }
    for (const s of (await client.query<{ code: string; source_id: string }>(
      'SELECT code, source_id FROM lead_source')).rows) ctx.sources.set(s.code, s.source_id);
    ctx.skus = (await client.query<{ id: string; code: string; name: string }>(
      'SELECT sku_id AS id, sku_code AS code, product_name AS name FROM sku')).rows;
    for (const e of (await client.query<{ employee_id: string; full_name: string }>(
      `SELECT employee_id, full_name FROM employee WHERE status = 'ACTIVE'`)).rows) {
      ctx.employees.set(e.full_name.toLowerCase(), e.employee_id);
      // "Riya Chauhan" in the roster is "Riya" in the sheets.
      const first = e.full_name.split(' ')[0]!.toLowerCase();
      if (!ctx.employees.has(first)) ctx.employees.set(first, e.employee_id);
    }

    console.log(`   ${ctx.dispositions.size} disposition spellings · ${ctx.employees.size} agent names known`);
    console.log(`   IMPORT_LIMIT=${limit} rows per large sheet\n`);

    await client.query('BEGIN');
    await importAddToCart(ctx, dir, limit);
    await importSkinwise(ctx, dir);
    await importShopify(ctx, dir);
    await importDelivered(ctx, dir, limit);
    await client.query('COMMIT');

    console.log('\n   ── loaded ──');
    console.log(`   customers   ${stats.customers}`);
    console.log(`   leads       ${stats.leads}`);
    console.log(`   activities  ${stats.activities}`);
    console.log(`   orders      ${stats.orders}`);
    console.log('\n   ── skipped, and why ──');
    console.log(`   no usable phone number   ${stats.skippedNoPhone}`);
    console.log(`   no usable name           ${stats.skippedNoName}`);
    console.log(`   amount was a DATE        ${stats.droppedAmount}  (lead kept, value left blank)`);
    if (stats.unknownDisposition.size) {
      console.log(`\n   outcomes with no alias yet (${stats.unknownDisposition.size}):`);
      console.log(`     ${[...stats.unknownDisposition].slice(0, 20).join(' · ')}`);
    }
    console.log('\nimport:client ok — the client\'s own data, never for production');
  } catch (e) {
    await client.query('ROLLBACK').catch(() => undefined);
    throw e;
  } finally {
    await client.end();
  }
}

main().catch((e: unknown) => {
  console.error(`\nimport:client failed:\n${(e as Error).message}\n`);
  process.exitCode = 1;
});
