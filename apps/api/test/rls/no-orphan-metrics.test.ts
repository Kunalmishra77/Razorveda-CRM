import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import pg from 'pg';
import { METRICS_BY_KEY } from '@razorveda/metrics';

/**
 * PHASE 4 EXIT CRITERION 3 — no orphan metrics.
 *
 * "No report may display a metric absent from docs/03-metric-dictionary.md."
 *
 * Reports read the certified views and nothing else, so the place to enforce this
 * is the views themselves: every measure a view exposes must correspond to a
 * registry key. A column that exists in a matview WILL end up on a screen — that
 * is what it is for — and once it is on a screen someone will ask what it means,
 * and the answer has to be the dictionary rather than whoever wrote the SQL.
 *
 * The registry already mirrors docs/03 under a parity test, so checking against
 * the registry checks against the doc.
 *
 * DIMENSIONS ARE NOT METRICS. `employee_id`, `kpi_date`, `ship_state` and the
 * like describe the grain rather than measuring anything, so they are listed
 * explicitly below instead of being pattern-matched away — a regex like "ends in
 * _id" would silently excuse a real measure that happened to fit.
 */

const DATABASE_URL = process.env['DATABASE_URL'];

/** Columns that identify the grain rather than measuring anything. */
const DIMENSIONS = new Set([
  'employee_id', 'kpi_date', 'source_id', 'source_code', 'funnel_date',
  'sku_id', 'sku_code', 'product_name', 'line_id', 'product_line', 'revenue_date',
  'rto_date', 'ship_state', 'payment_mode', 'booked_by_employee_id', 'perf_date',
  'customer_id', 'full_name', 'primary_phone', 'owner_employee_id', 'next_due_date',
]);

/**
 * Where a view column's name differs from its registry key.
 *
 * Kept small and explicit. Each entry is a place the SQL and the dictionary use
 * different words for the same number, which is worth seeing rather than hiding.
 */
const ALIASES: Readonly<Record<string, string>> = {
  leads_assigned: 'no_of_data',
  leads_touched: 'cd',
  leads_untouched: 'untouched_leads',
  // docs/04 requires self-reported metrics to be visibly labelled, so the
  // columns carry the suffix and map back to the plain dictionary keys.
  dials_self_reported: 'total_dialling',
  connects_self_reported: 'num_of_connect',
  connectivity_pct_self_reported: 'connectivity_pct',
  orders_booked: 'total_orders',
  orders_delivered: 'total_orders',
  orders_dispatched: 'total_orders',
  rto_count: 'rto_pct',
  rto_value: 'rto_pct',
  returned_value: 'rto_pct',
  units_returned: 'rto_pct',
  units_delivered: 'total_orders',
  upsell_units: 'upsell_index',
  credit_earned: 'realised_credited_value',
  dispositions_filled: 'followup_sla_pct',
  leads_arrived: 'no_of_data',
  leads_unassigned: 'untouched_leads',
  leads_converted: 'conversion_pct',
  value_per_lead: 'per_day_avg_value',
  avg_prepaid_ratio: 'prepaid_ratio',
  lifetime_orders: 'buyers_fq',
  lifetime_value: 'realised_value',
  days_until_due: 'data_ageing',
};

const VIEWS = [
  'mv_daily_employee_kpi',
  'mv_source_funnel_daily',
  'mv_product_revenue_daily',
  'mv_rto_analysis',
  'mv_geography_performance',
  'mv_repeat_due_queue',
];

let pool: pg.Pool;

beforeAll(async () => {
  if (!DATABASE_URL) {
    throw new Error('DATABASE_URL is not set. These tests require a live database and will not skip.');
  }
  pool = new pg.Pool({ connectionString: DATABASE_URL });
});

afterAll(async () => {
  await pool?.end();
});

const columnsOf = async (view: string): Promise<string[]> => {
  const { rows } = await pool.query<{ attname: string }>(
    `SELECT a.attname
       FROM pg_attribute a
       JOIN pg_class c ON c.oid = a.attrelid
       JOIN pg_namespace n ON n.oid = c.relnamespace
      WHERE n.nspname = 'public' AND c.relname = $1 AND a.attnum > 0 AND NOT a.attisdropped
      ORDER BY a.attnum`,
    [view],
  );
  return rows.map((r) => r.attname);
};

describe('every certified view exists', () => {
  it('all six are present, so the test cannot pass over nothing', async () => {
    for (const view of VIEWS) {
      expect((await columnsOf(view)).length, `${view} has no columns — is it created?`)
        .toBeGreaterThan(0);
    }
  });
});

describe('criterion 3 — no view exposes a metric the dictionary does not define', () => {
  for (const view of VIEWS) {
    it(`${view}`, async () => {
      const orphans: string[] = [];
      for (const column of await columnsOf(view)) {
        if (DIMENSIONS.has(column)) continue;
        const key = ALIASES[column] ?? column;
        if (!METRICS_BY_KEY.has(key)) orphans.push(column);
      }
      // A column here means either the metric belongs in docs/03, or the view is
      // exposing something nobody has defined. Both are worth stopping for.
      expect(orphans).toEqual([]);
    });
  }
});

describe('the alias list stays honest', () => {
  it('every alias points at a metric that really exists', async () => {
    const dangling = Object.entries(ALIASES)
      .filter(([, key]) => !METRICS_BY_KEY.has(key))
      .map(([column, key]) => `${column} -> ${key}`);
    expect(dangling).toEqual([]);
  });

  it('every alias is for a column some view actually has', async () => {
    // An alias for a column that no longer exists is dead weight that makes the
    // next reader trust the list less — and could quietly excuse a new column
    // that happens to reuse the name.
    const all = new Set((await Promise.all(VIEWS.map(columnsOf))).flat());
    const unused = Object.keys(ALIASES).filter((column) => !all.has(column));
    expect(unused).toEqual([]);
  });
});
