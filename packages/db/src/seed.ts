import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { hash } from '@node-rs/argon2';
import { randomBytes } from 'node:crypto';
import { ARGON2ID_PARAMS, SYSTEM_ACTOR_EMAIL } from '@razorveda/shared';
import pg from 'pg';
import { asBool, asNumber, asPipeList, orNull, parseCsv, type CsvRow } from './csv.js';
import { WEEKDAY, generateYear, type Weekday } from './calendar.js';
import { assertLocalTarget, requireDatabaseUrl } from './env.js';
import { assertLocalDevDatabase } from './sentinel.js';

/**
 * Idempotent seed loader.
 *
 * Phase 0 exit criterion 2: running this twice must leave row counts identical.
 * Every insert is ON CONFLICT on a natural key, so a re-run updates in place and
 * never duplicates.
 *
 * Resolves line_code -> line_id and disposition_code -> disposition_id, and creates
 * an app_user with an Argon2id hash for every row in employees.csv.
 *
 *   npm run db:seed
 *   npm run db:seed -- --year 2027 --non-working 0,6
 */

const seedPath = (n: string) => fileURLToPath(new URL(`../../../db/seed/${n}`, import.meta.url));
const readSeed = (n: string): CsvRow[] => parseCsv(readFileSync(seedPath(n), 'utf8'));

function argValue(flag: string): string | undefined {
  const i = process.argv.indexOf(flag);
  return i >= 0 ? process.argv[i + 1] : undefined;
}

/**
 * Neither the year nor the weekend shape is hardcoded. O-08 is signed off on the
 * RULE (both denominators read working_calendar), not on a fixed calendar, and
 * festival closures must arrive as data rather than a code change (D-34).
 */
function calendarOptions(): { year: number; nonWorking: Weekday[]; holidays: string[] } {
  const year = Number(argValue('--year') ?? new Date().getUTCFullYear());
  const nw = argValue('--non-working');
  const nonWorking = (nw ? nw.split(',').map(Number) : [WEEKDAY.SUNDAY]) as Weekday[];
  const hol = argValue('--holidays');
  return { year, nonWorking, holidays: hol ? hol.split(',') : [] };
}

/**
 * Local-only default. The seed never runs against a remote target (D-17), and a
 * real deployment provisions credentials out of band.
 */
const DEV_PASSWORD = process.env['SEED_DEFAULT_PASSWORD'] ?? 'razorveda-dev-only';

async function main(): Promise<void> {
  const target = requireDatabaseUrl();
  assertLocalTarget(target, 'seed');

  const client = new pg.Client({ connectionString: target.url });
  await client.connect();
  console.log(`-> ${target.user}@${target.host}:${target.port}/${target.database}`);

  try {
    // Host check already passed in assertLocalTarget. This is the independent one
    // that a tunnelled production database cannot satisfy (D-40).
    await assertLocalDevDatabase(client, 'seed');

    await client.query('BEGIN');

    // ── product lines ────────────────────────────────────────────────────
    const lines = readSeed('product_lines.csv');
    for (const r of lines) {
      await client.query(
        `INSERT INTO product_line (code, name, is_active) VALUES ($1,$2,$3)
         ON CONFLICT (code) DO UPDATE SET name = EXCLUDED.name, is_active = EXCLUDED.is_active`,
        [r['code'], r['name'], asBool(r['is_active'])],
      );
    }

    // line_code -> line_id, so skus.csv never carries a UUID
    const lineIds = new Map<string, string>(
      (await client.query<{ code: string; line_id: string }>(
        'SELECT code, line_id FROM product_line',
      )).rows.map((r) => [r.code, r.line_id]),
    );

    // ── skus ─────────────────────────────────────────────────────────────
    const skus = readSeed('skus.csv');
    for (const r of skus) {
      const lineId = lineIds.get(r['line_code'] ?? '');
      if (!lineId) throw new Error(`skus.csv: unknown line_code "${r['line_code']}"`);
      await client.query(
        `INSERT INTO sku (sku_code, product_name, line_id, variant, pack_size, mrp,
                          shopify_base_price, usage_days, name_aliases)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)
         ON CONFLICT (sku_code) DO UPDATE SET
           product_name = EXCLUDED.product_name, line_id = EXCLUDED.line_id,
           variant = EXCLUDED.variant, pack_size = EXCLUDED.pack_size, mrp = EXCLUDED.mrp,
           -- Never overwrite a price an admin has confirmed: re-running the seed
           -- must not quietly replace a real number with the inferred one (D-81).
           shopify_base_price = CASE WHEN sku.shopify_base_price_confirmed
                                     THEN sku.shopify_base_price
                                     ELSE EXCLUDED.shopify_base_price END,
           usage_days = EXCLUDED.usage_days, name_aliases = EXCLUDED.name_aliases,
           updated_at = now()`,
        [
          r['sku_code'], r['product_name'], lineId, orNull(r['variant']), orNull(r['pack_size']),
          asNumber(r['mrp']),
          // O-02: these are reverse-engineered from order data, not confirmed.
          asNumber(r['shopify_base_price']),
          // O-03: estimates. Drives the repeat-purchase engine.
          asNumber(r['usage_days']),
          asPipeList(r['name_aliases']),
        ],
      );
    }

    // ── lead sources ─────────────────────────────────────────────────────
    for (const r of readSeed('lead_sources.csv')) {
      await client.query(
        `INSERT INTO lead_source (code, display_name, validity_days, expected_conversion_rate,
                                  attribution, employee_credit_percent, date_locale)
         VALUES ($1,$2,$3,$4,$5::attribution_rule,$6,$7)
         ON CONFLICT (code) DO UPDATE SET
           display_name = EXCLUDED.display_name, validity_days = EXCLUDED.validity_days,
           expected_conversion_rate = EXCLUDED.expected_conversion_rate,
           attribution = EXCLUDED.attribution,
           employee_credit_percent = EXCLUDED.employee_credit_percent,
           date_locale = EXCLUDED.date_locale`,
        [
          r['code'], r['display_name'], asNumber(r['validity_days']),
          asNumber(r['expected_conversion_rate']), r['attribution'],
          // 100 everywhere in v1. O-11 asks the client about recovery sources (D-16).
          asNumber(r['employee_credit_percent']), r['date_locale'],
        ],
      );
    }

    // ── dispositions, then aliases resolved by code ──────────────────────
    for (const r of readSeed('dispositions.csv')) {
      await client.query(
        `INSERT INTO disposition (code, label, category, is_terminal,
                                  requires_followup_date, counts_as_connect, sort_order)
         VALUES ($1,$2,$3::disposition_cat,$4,$5,$6,$7)
         ON CONFLICT (code) DO UPDATE SET
           label = EXCLUDED.label, category = EXCLUDED.category,
           is_terminal = EXCLUDED.is_terminal,
           requires_followup_date = EXCLUDED.requires_followup_date,
           counts_as_connect = EXCLUDED.counts_as_connect, sort_order = EXCLUDED.sort_order`,
        [
          r['code'], r['label'], r['category'], asBool(r['is_terminal']),
          asBool(r['requires_followup_date']), asBool(r['counts_as_connect']),
          asNumber(r['sort_order']),
        ],
      );
    }

    const dispIds = new Map<string, string>(
      (await client.query<{ code: string; disposition_id: string }>(
        'SELECT code, disposition_id FROM disposition',
      )).rows.map((r) => [r.code, r.disposition_id]),
    );

    // Fixes F4: 49 spellings of ~12 outcomes. D-20 asserts every alias resolves.
    for (const r of readSeed('disposition_aliases.csv')) {
      const id = dispIds.get(r['disposition_code'] ?? '');
      if (!id) {
        throw new Error(`disposition_aliases.csv: unknown disposition_code "${r['disposition_code']}"`);
      }
      await client.query(
        `INSERT INTO disposition_alias (disposition_id, alias) VALUES ($1,$2)
         ON CONFLICT (alias) DO UPDATE SET disposition_id = EXCLUDED.disposition_id`,
        [id, (r['alias'] ?? '').toLowerCase()],
      );
    }

    // ── incentive slabs ──────────────────────────────────────────────────
    // Defaults in docs/03 section 6 are PROPOSALS, not the client's scheme (O-09).
    for (const r of readSeed('incentive_slabs.csv')) {
      await client.query(
        `INSERT INTO incentive_slab (min_value, max_value, percent, effective_from)
         SELECT $1,$2,$3,$4
         WHERE NOT EXISTS (
           SELECT 1 FROM incentive_slab
            WHERE min_value = $1 AND percent = $3 AND effective_from = $4)`,
        [asNumber(r['min_value']), asNumber(r['max_value']), asNumber(r['percent']),
         r['effective_from']],
      );
    }

    // ── incentive modifiers ──────────────────────────────────────────────
    // docs/03 section 6: "all slabs and modifiers live in tables, versioned,
    // admin-editable. Never hardcoded." These are the PROPOSALS from that section
    // and are seeded `is_provisional = true`, so every figure computed from them
    // is labelled provisional until O-09 is answered. No SPIF is seeded: a
    // product promotion is a decision with a date, not a default.
    for (const r of readSeed('incentive_modifiers.csv')) {
      await client.query(
        `INSERT INTO incentive_modifier (kind, threshold_min, threshold_max, line_id,
                                         value, effective_from, note, is_provisional)
         SELECT $1::incentive_modifier_kind, $2, $3,
                (SELECT line_id FROM product_line WHERE code = $4), $5, $6, $7, true
          WHERE NOT EXISTS (
            SELECT 1 FROM incentive_modifier
             WHERE kind = $1::incentive_modifier_kind
               AND threshold_min IS NOT DISTINCT FROM $2
               AND effective_from = $6)`,
        [
          r['kind'], asNumber(r['threshold_min']), asNumber(r['threshold_max']),
          r['line_code'] || null, asNumber(r['value']), r['effective_from'], r['note'],
        ],
      );
    }

    // ── users and employees ──────────────────────────────────────────────
    // 13 rows: 1 OWNER, 3 ADMIN, 9 EMPLOYEE. Roster is provisional pending O-01 (D-19).
    // Parameters are pinned in @razorveda/shared so a library swap cannot change
    // the cost factor without a failing test (packages/db/test/argon2.test.ts).
    const passwordHash = await hash(DEV_PASSWORD, ARGON2ID_PARAMS);

    for (const r of readSeed('employees.csv')) {
      const role = r['role'] ?? 'EMPLOYEE';

      // O-07 is open: nobody has nominated the OWNER. Seeding a real person would
      // be inventing a business decision, so the account exists but is LOCKED and
      // cannot authenticate until an admin claims it (docs/05 test 8 already
      // requires exactly that behaviour). No schema change needed.
      const isOwner = role === 'OWNER';
      const lockedReason = isOwner
        ? 'OWNER account not yet nominated (O-07). Set the real email and unlock to claim.'
        : null;

      const { rows: [user] } = await client.query<{ user_id: string }>(
        `INSERT INTO app_user (email, password_hash, role, is_locked, locked_reason)
         VALUES ($1,$2,$3::user_role,$4,$5)
         ON CONFLICT (email) DO UPDATE SET role = EXCLUDED.role
         RETURNING user_id`,
        [r['email'], passwordHash, role, isOwner, lockedReason],
      );
      if (!user) throw new Error(`failed to upsert app_user for ${r['email']}`);

      await client.query(
        `INSERT INTO employee (user_id, emp_code, full_name, status, monthly_target,
                               wip_cap, shift_start, shift_end, joined_on)
         VALUES ($1,$2,$3,$4::employee_status,$5,$6,$7,$8,$9)
         ON CONFLICT (emp_code) DO UPDATE SET
           user_id = EXCLUDED.user_id, full_name = EXCLUDED.full_name,
           status = EXCLUDED.status, monthly_target = EXCLUDED.monthly_target,
           wip_cap = EXCLUDED.wip_cap, shift_start = EXCLUDED.shift_start,
           shift_end = EXCLUDED.shift_end, joined_on = EXCLUDED.joined_on, updated_at = now()`,
        [
          user.user_id, r['emp_code'], r['full_name'], r['status'],
          asNumber(r['monthly_target']), asNumber(r['wip_cap']),
          r['shift_start'], r['shift_end'], orNull(r['joined_on']),
        ],
      );
    }

    // ── the identity scheduled jobs act as ───────────────────────────────
    // Created HERE and not from employees.csv on purpose: a row in that file
    // becomes an employee, and an employee shows up in rosters, targets, scores
    // and incentive runs. This must be an app_user and nothing else.
    //
    // LOCKED FOREVER, and the password is a random value this process throws away
    // without printing it. Even unlocking the account by mistake would not create
    // a usable login. The only thing it can do is be the actor on rows written by
    // the scheduler, which is the entire point (see SYSTEM_ACTOR_EMAIL).
    const systemHash = await hash(randomBytes(48).toString('hex'), ARGON2ID_PARAMS);
    await client.query(
      `INSERT INTO app_user (email, password_hash, role, is_locked, locked_reason)
       VALUES ($1, $2, 'ADMIN', true, $3)
       ON CONFLICT (email) DO UPDATE SET
         role = 'ADMIN', is_locked = true, locked_reason = EXCLUDED.locked_reason`,
      [
        SYSTEM_ACTOR_EMAIL,
        systemHash,
        'Not a login. This is the actor scheduled jobs write as. Never unlock it: '
          + 'it has no known password and no employee record.',
      ],
    );
    console.log(`   system actor ${SYSTEM_ACTOR_EMAIL} -> ADMIN, locked, no employee row`);


    // ── seasonality index ────────────────────────────────────────────────
    // Seeded 1.0 for all twelve months, provisional. Cannot be fitted on five
    // months of history; the term stays in Forecast and the value is neutralised
    // (D-44). Revisit at 18+ months or when O-06 releases the 2025 archive.
    for (const r of readSeed('seasonality_index.csv')) {
      await client.query(
        `INSERT INTO seasonality_index (month_of_year, index_value, is_provisional, note)
         VALUES ($1,$2,$3,$4)
         ON CONFLICT (month_of_year) DO UPDATE SET
           index_value = EXCLUDED.index_value,
           is_provisional = EXCLUDED.is_provisional,
           note = EXCLUDED.note, updated_at = now()`,
        [asNumber(r['month_of_year']), asNumber(r['index_value']),
         asBool(r['is_provisional']), orNull(r['note'])],
      );
    }

    // ── working calendar ─────────────────────────────────────────────────
    const { year, nonWorking, holidays } = calendarOptions();
    const days = generateYear(year, { nonWorkingWeekdays: nonWorking, holidays });
    for (const d of days) {
      await client.query(
        `INSERT INTO working_calendar (calendar_date, is_working_day) VALUES ($1,$2)
         ON CONFLICT (calendar_date) DO UPDATE SET is_working_day = EXCLUDED.is_working_day`,
        [d.calendarDate, d.isWorkingDay],
      );
    }

    await client.query('COMMIT');

    console.log(`   calendar ${year}: ${days.filter((d) => d.isWorkingDay).length} working days ` +
      `(non-working weekdays [${nonWorking.join(',')}], ${holidays.length} holidays)`);
    console.log('   NOTE: calendar is PROVISIONAL until O-08 festival closures are confirmed.');
    console.log('   NOTE: OWNER account is seeded LOCKED until O-07 nominates a person.');
    console.log('   NOTE: seasonality_index is 1.0 for all months and PROVISIONAL (D-44) -');
    console.log('         the forecast is NOT seasonally adjusted. Do not describe it as such.');
    console.log('seed: ok');
  } catch (e) {
    await client.query('ROLLBACK');
    throw e;
  } finally {
    await client.end();
  }
}

main().catch((e: unknown) => {
  console.error(`\nseed failed:\n${(e as Error).message}\n`);
  process.exitCode = 1;
});
