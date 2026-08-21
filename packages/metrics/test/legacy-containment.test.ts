import { describe, it, expect } from 'vitest';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { METRICS, legacyMetrics, liveMetrics, statusOf } from '../src/registry.js';

/**
 * N8 / D-38: a `legacy` metric is recorded so Phase 2 can reproduce the client's
 * number in the variance report, and refused everywhere else.
 *
 * "The render layer refuses to display it" is worthless as a comment — somebody
 * will wire `approx_guess_rest_of_month` into a dashboard because it was sitting
 * right there in the registry next to Forecast. This test makes that a red build.
 *
 * The reconciliation module does not exist yet (Phase 2). That is fine: the check
 * finds zero references today and starts constraining the moment one appears.
 */

const repoRoot = fileURLToPath(new URL('../../..', import.meta.url));

/** Only these may name a legacy metric key. */
const ALLOWED = [
  join('packages', 'metrics', 'src', 'registry.ts'),
  join('packages', 'metrics', 'test'),
  join('packages', 'metrics', 'src', 'reconciliation'),
  join('apps', 'api', 'src', 'reconciliation'),
  join('apps', 'worker', 'src', 'reconciliation'),
];

const SKIP_DIRS = new Set(['node_modules', '.git', 'dist', '.next', 'coverage', 'docs', 'fixtures']);

function sourceFiles(dir: string, acc: string[] = []): string[] {
  let entries: string[];
  try {
    entries = readdirSync(dir);
  } catch {
    return acc;
  }
  for (const name of entries) {
    if (SKIP_DIRS.has(name)) continue;
    const full = join(dir, name);
    if (statSync(full).isDirectory()) sourceFiles(full, acc);
    else if (/\.(ts|tsx|sql)$/.test(name)) acc.push(full);
  }
  return acc;
}

const isAllowed = (rel: string) => ALLOWED.some((a) => rel === a || rel.startsWith(a + sep));

describe('legacy metric containment (N8, D-38)', () => {
  it('registers Approx Guess Rest of Month as legacy rather than omitting it', () => {
    const m = METRICS.find((x) => x.key === 'approx_guess_rest_of_month');
    expect(m, 'legacy metrics are recorded, not deleted — rule 1 stays unbroken').toBeDefined();
    expect(statusOf(m!)).toBe('legacy');
  });

  it('keeps Forecast live — it is the replacement, not the legacy one', () => {
    expect(statusOf(METRICS.find((m) => m.key === 'forecast')!)).toBe('live');
    expect(statusOf(METRICS.find((m) => m.key === 'per_day_avg_value')!)).toBe('live');
  });

  it('never references a legacy metric key outside the reconciliation module', () => {
    const keys = legacyMetrics().map((m) => m.key);
    expect(keys.length, 'no legacy metrics to contain — did the registry change?')
      .toBeGreaterThan(0);

    const offenders: string[] = [];
    for (const root of ['packages', 'apps']) {
      for (const file of sourceFiles(join(repoRoot, root))) {
        const rel = relative(repoRoot, file);
        if (isAllowed(rel)) continue;
        const body = readFileSync(file, 'utf8');
        for (const key of keys) {
          if (body.includes(key)) offenders.push(`${rel} references "${key}"`);
        }
      }
    }

    expect(
      offenders,
      `LEGACY METRIC USED OUTSIDE RECONCILIATION.\n\n${offenders.join('\n')}\n\n` +
        `A legacy metric exists only so the Phase 2 variance report can reproduce the\n` +
        `client's figure. It must never reach a screen, a certified view, or an API\n` +
        `response. Use the live replacement instead — for Approx Guess Rest of Month\n` +
        `that is "forecast". (N8, decision D-38)`,
    ).toEqual([]);
  });

  it('exposes live and legacy as disjoint sets covering the registry', () => {
    expect(liveMetrics().length + legacyMetrics().length).toBe(METRICS.length);
    const overlap = liveMetrics().filter((m) => legacyMetrics().includes(m));
    expect(overlap).toEqual([]);
  });
});

/**
 * D-39: all metric arithmetic runs on exact values; rounding happens once, at render.
 *
 * The registry carries no view SQL yet (Phase 4). Writing the check now means the
 * first person to add a view gets the rule enforced rather than discovering it in
 * review — which is the moment it is cheapest to obey.
 */
describe('exact arithmetic (D-39)', () => {
  const withSql = METRICS.filter((m) => typeof m.sql === 'string' && m.sql.trim() !== '');

  it('never rounds inside an aggregate', () => {
    // SUM(ROUND(x)) is a defect; ROUND(SUM(x)) is fine.
    const bad = withSql.filter((m) =>
      /\b(SUM|AVG|COUNT|MIN|MAX)\s*\(\s*ROUND\s*\(/i.test(m.sql ?? ''),
    );
    expect(
      bad.map((m) => m.key),
      'ROUND() inside an aggregate. SUM(ROUND(x)) rounds every row before adding ' +
        'it up — a rounded intermediate escaping into a computed result (D-39).',
    ).toEqual([]);
  });

  it('never computes on a _display column', () => {
    // A view may expose a rounded column with a _display suffix. Nothing may use it.
    const bad = withSql.filter((m) => /\w+_display\s*[*/+-]|[*/+-]\s*\w+_display/.test(m.sql ?? ''));
    expect(
      bad.map((m) => m.key),
      'arithmetic on a _display column. Displayed values are rounded; computing on ' +
        'one is how 1,25,341 became 1,25,340 (D-39).',
    ).toEqual([]);
  });

  it('documents that the check is inert until views land', () => {
    // Guard the guard: if this ever silently applies to nothing forever, the two
    // assertions above are decoration. This records the current state honestly.
    expect(withSql.length).toBe(0);
  });
});
