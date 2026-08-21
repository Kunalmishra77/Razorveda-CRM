import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { METRICS, METRICS_BY_KEY, scoreComponents } from '../src/registry.js';

/**
 * docs/03 rule 3: "packages/metrics has a test that FAILS if this file and the
 * registry drift apart."
 *
 * This is that test, and it is the single most valuable artefact in Phase 0.
 * Two years from now it is the only thing standing between the client and a
 * second metric dictionary that nobody trusts.
 *
 * It fails in BOTH directions on purpose:
 *   - a metric in docs/03 with no registry entry  -> fail
 *   - a registry entry with no docs/03 row        -> fail
 *
 * If a change makes this test fail, the fix is to change the document and the
 * registry together. Never relax the assertion to make a build pass.
 */

const DOC_PATH = '../../../docs/03-metric-dictionary.md';
const doc = readFileSync(fileURLToPath(new URL(DOC_PATH, import.meta.url)), 'utf8');

/**
 * A metric table in docs/03 is any markdown table whose FIRST header cell is
 * "Metric" (sections 1-4) or "Component" (section 5).
 *
 * That deliberately excludes the other tables in the file, which are not
 * metrics: the source attribution rule table (first cell `lead_source.code`),
 * the incentive lever table ("Lever") and the period basis table ("Basis").
 */
const METRIC_TABLE_HEADERS = new Set(['metric', 'component']);

/** Strip bold markers, backticks and any trailing parenthetical gloss. */
function cleanName(cell: string): string {
  return cell
    .replace(/\*\*/g, '')
    .replace(/`/g, '')
    .replace(/\s*\([^)]*\)\s*$/, '')
    .trim();
}

function splitRow(line: string): string[] {
  return line
    .replace(/^\s*\|/, '')
    .replace(/\|\s*$/, '')
    .split('|')
    .map((c) => c.trim());
}

const isSeparator = (line: string) => /^\s*\|[\s:|-]+\|\s*$/.test(line);

/** Extract every metric name from docs/03, with the section it appeared under. */
function parseDocMetrics(md: string): Array<{ name: string; section: number }> {
  const out: Array<{ name: string; section: number }> = [];
  const lines = md.split(/\r?\n/);

  let section = 0;
  let inMetricTable = false;

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i] ?? '';

    const heading = /^##\s+(\d+)\./.exec(line);
    if (heading) {
      section = Number(heading[1]);
      inMetricTable = false;
      continue;
    }

    if (!line.trim().startsWith('|')) {
      inMetricTable = false;
      continue;
    }

    if (isSeparator(line)) continue;

    const cells = splitRow(line);
    const first = cleanName(cells[0] ?? '').toLowerCase();

    // A header row starts a table. Decide whether it is a metric table.
    if (METRIC_TABLE_HEADERS.has(first)) {
      inMetricTable = true;
      continue;
    }
    if (!inMetricTable) continue;
    // Any other header-looking row ends the run.
    if (first === '' ) continue;

    const name = cleanName(cells[0] ?? '');
    if (name) out.push({ name, section });
  }
  return out;
}

const docMetrics = parseDocMetrics(doc);

/** Key that tolerates "Upsell Index" appearing in both section 4 and section 5. */
const idOf = (m: { name: string; section: number }) => `${m.section}:${m.name}`;

describe('metric registry <-> docs/03-metric-dictionary.md', () => {
  it('finds metric tables in the dictionary at all', () => {
    // A parser that silently matches nothing would make every other assertion
    // in this file vacuously pass. Guard the guard.
    expect(docMetrics.length).toBeGreaterThan(20);
    expect(new Set(docMetrics.map((m) => m.section))).toEqual(new Set([1, 2, 3, 4, 5]));
  });

  it('has a registry entry for every metric in the dictionary', () => {
    const registryIds = new Set(METRICS.map(idOf));
    const missing = docMetrics.filter((m) => !registryIds.has(idOf(m)));
    expect(
      missing.map(idOf),
      `In docs/03 but NOT in the registry. Add them to packages/metrics/src/registry.ts:\n` +
        missing.map((m) => `  section ${m.section}: ${m.name}`).join('\n'),
    ).toEqual([]);
  });

  it('has a dictionary row for every metric in the registry', () => {
    const docIds = new Set(docMetrics.map(idOf));
    const orphans = METRICS.filter((m) => !docIds.has(idOf(m)));
    expect(
      orphans.map(idOf),
      `In the registry but NOT in docs/03. A metric that is not in the dictionary ` +
        `does not exist and no screen may display it (docs/03 rule 1):\n` +
        orphans.map((m) => `  ${m.key} -> section ${m.section}: ${m.name}`).join('\n'),
    ).toEqual([]);
  });

  it('counts match exactly', () => {
    expect(METRICS.length).toBe(docMetrics.length);
  });
});

describe('registry internal consistency', () => {
  it('has unique keys', () => {
    const keys = METRICS.map((m) => m.key);
    expect(new Set(keys).size, 'duplicate metric keys').toBe(keys.length);
    expect(METRICS_BY_KEY.size).toBe(keys.length);
  });

  it('uses snake_case keys', () => {
    const bad = METRICS.filter((m) => !/^[a-z][a-z0-9_]*$/.test(m.key)).map((m) => m.key);
    expect(bad, `keys must be snake_case: ${bad.join(', ')}`).toEqual([]);
  });

  it('gives every metric a grain and a formula', () => {
    const incomplete = METRICS.filter((m) => !m.grain.trim() || !m.formula.trim()).map((m) => m.key);
    expect(incomplete).toEqual([]);
  });

  it('EES score component weights sum to exactly 1.00', () => {
    // docs/03 section 5: 25 + 25 + 20 + 15 + 10 + 5.
    const total = scoreComponents().reduce((s, m) => s + (m.weight ?? 0), 0);
    expect(Math.round(total * 100) / 100).toBe(1);
  });

  it('marks dials, connects and connectivity as self-reported', () => {
    // Reps dial from their own handsets (D-03), so these are claimed, not measured.
    // docs/04 requires the UI to label them. The registry is where that flag lives.
    for (const key of ['total_dialling', 'num_of_connect', 'connectivity_pct']) {
      expect(METRICS_BY_KEY.get(key)?.selfReported, `${key} must be selfReported`).toBe(true);
    }
  });

  it("Today's CD reads first_connected_at, never first_contact_at", () => {
    // Defect B5: contact is not connect. Substituting the wrong column silently
    // inflates CD, which is one of the metrics the client already trusts.
    const formula = METRICS_BY_KEY.get('todays_cd')?.formula ?? '';
    expect(formula).toContain('first_connected_at');
    expect(formula).not.toContain('first_contact_at');
  });

  it('Untouched Leads reads contact_attempts, never activity_count', () => {
    const formula = METRICS_BY_KEY.get('untouched_leads')?.formula ?? '';
    expect(formula).toContain('contact_attempts');
    expect(formula).not.toContain('activity_count');
  });

  it('Required Booking Value uses the RTO-adjusted formula, not a flat multiplier', () => {
    // F11: the flat x1.15 understated Kajal's requirement by 47%.
    const formula = METRICS_BY_KEY.get('required_booking_value')?.formula ?? '';
    expect(formula).toContain('rep_rolling_90d_RTO');
    expect(formula).not.toContain('1.15');
  });

  it('Realised Value is keyed on delivered_date (cash basis, D-13)', () => {
    const formula = METRICS_BY_KEY.get('realised_value')?.formula ?? '';
    expect(formula).toContain('delivered_date');
    expect(formula).toContain('DELIVERED');
  });

  it('Total Orders is a distinct count, never derived from value / AOV', () => {
    // F9: the client's Achieve Report shows 73.8 and 5.22 orders because volume
    // is derived rather than counted.
    const formula = METRICS_BY_KEY.get('total_orders')?.formula ?? '';
    expect(formula).toContain('COUNT(DISTINCT order_id)');
  });
});
