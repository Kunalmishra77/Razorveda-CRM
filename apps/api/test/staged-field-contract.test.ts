import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

/**
 * THE STAGING CONTRACT — the seam where four fields were silently lost.
 *
 * `normalised_json` is written by ingestion.controller.ts and read back by
 * commit.service.ts as `data['someKey']`. Nothing connects the two: the writer is
 * an object literal, the reader is a string index, and TypeScript sees a
 * `Record<string, unknown>` on both sides and is perfectly happy.
 *
 * What that cost, all four found by re-proving Phase 2's exit criteria rather
 * than by any test:
 *
 *   paymentMode        parsed correctly, never staged, so commit coalesced EVERY
 *                      ingested order to UNKNOWN. Prepaid Ratio — the strongest
 *                      RTO predictor available (F5) — was unmeasurable for the
 *                      second time, by a different mechanism.
 *   externalRef        never staged, so order_number fell back to a value unique
 *                      per CUSTOMER rather than per ORDER. A repeat buyer's second
 *                      order in one file hit ON CONFLICT DO NOTHING and vanished.
 *   legacyCreditValue  never staged, so the reconciliation report docs/06 §4
 *                      promises had nothing to reconcile.
 *
 * A reader with no writer is dead code. A writer with no reader is a dropped
 * field. This test fails on either, so the seam cannot drift again in silence.
 */

const here = dirname(fileURLToPath(import.meta.url));
const src = (f: string): string => readFileSync(join(here, '..', 'src', 'ingestion', f), 'utf8');

/** Keys the commit step reads out of normalised_json. */
function keysRead(): Set<string> {
  const body = src('commit.service.ts');
  return new Set([...body.matchAll(/\bdata\['([A-Za-z0-9_]+)'\]/g)].map((m) => m[1]!));
}

/** Keys the staging step writes into normalised_json. */
function keysWritten(): Set<string> {
  const body = src('ingestion.controller.ts');
  const start = body.indexOf('INSERT INTO staging_row');
  const literal = body.slice(body.indexOf('JSON.stringify({', start), body.indexOf('status, JSON.stringify(issues)', start));
  // Property names at the head of a line or after a comma — enough for an object
  // literal, and it fails loudly rather than quietly if the shape ever changes.
  return new Set([...literal.matchAll(/(?:^|[{,])\s*(?:\/\/[^\n]*\n\s*)*([A-Za-z][A-Za-z0-9_]*)\s*:/gm)].map((m) => m[1]!));
}

describe('normalised_json is a contract, not a convention', () => {
  it('every field commit reads is one staging actually writes', () => {
    const missing = [...keysRead()].filter((k) => !keysWritten().has(k));
    // If this fails, commit is reading a key nobody sets: it will silently take
    // its fallback — null, '0', or 'UNKNOWN' — for every row ever imported.
    expect(missing).toEqual([]);
  });

  it('finds a real set of keys on both sides, so the test cannot pass vacuously', () => {
    // Guard the guard. Both sides are found by regex over source; if a refactor
    // changes the shape enough to match nothing, the first assertion would pass
    // trivially and prove nothing.
    expect(keysRead().size).toBeGreaterThan(5);
    expect(keysWritten().size).toBeGreaterThan(5);
  });

  it('stages the three fields whose loss was invisible', () => {
    const written = keysWritten();
    for (const key of ['paymentMode', 'externalRef', 'legacyCreditValue']) {
      expect(written.has(key), `${key} is not staged`).toBe(true);
    }
  });
});
