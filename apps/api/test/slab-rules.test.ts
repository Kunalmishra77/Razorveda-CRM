import { describe, it, expect } from 'vitest';
import { validateSlabs } from '../src/master/slab-rules.js';

/**
 * The incentive slab rule (docs/03 §6).
 *
 * This file exists because a mutation check found the rule untested: deleting the
 * gap validation outright broke nothing, since the only way to reach it was
 * through a service needing a database and an admin session.
 */

const slab = (min: string, max: string | null, percent: string) => ({
  minValue: min, maxValue: max, percent,
});

describe('a valid scheme', () => {
  it('accepts contiguous bands starting at zero', () => {
    const v = validateSlabs([
      slab('0', '100000', '0'),
      slab('100000', '250000', '2.5'),
      slab('250000', null, '4'),
    ]);
    expect(v.ok).toBe(true);
  });

  it('sorts them, so the admin can enter them in any order', () => {
    const v = validateSlabs([
      slab('250000', null, '4'),
      slab('0', '100000', '0'),
      slab('100000', '250000', '2.5'),
    ]);
    expect(v.ok).toBe(true);
    if (v.ok) expect(v.sorted.map((s) => s.minValue)).toEqual(['0', '100000', '250000']);
  });
});

describe('the gap check — the rule the mutation check found untested', () => {
  it('refuses a hole between two bands', () => {
    const v = validateSlabs([slab('0', '100000', '0'), slab('200000', null, '3')]);
    expect(v.ok).toBe(false);
    if (!v.ok) {
      expect(v.message).toMatch(/gap between ₹100000 and ₹200000/);
      // The message says what it COSTS, not just that it is invalid: a rep in the
      // hole has no slab and her statement refuses to calculate.
      expect(v.message).toMatch(/refuse to calculate/i);
    }
  });

  it('refuses the off-by-one hole that reads as contiguous', () => {
    // "0–99,999 then 100,000+" looks complete and leaves everything between
    // 99,999 and 100,000 uncovered. It sounds pedantic until a rep lands on
    // 99,999.50 — and the client's own sheet is written this way.
    const v = validateSlabs([slab('0', '99999', '0'), slab('100000', null, '2')]);
    expect(v.ok).toBe(false);
  });

  it('refuses a scheme that does not start at zero', () => {
    const v = validateSlabs([slab('100000', '250000', '2'), slab('250000', null, '4')]);
    expect(v.ok).toBe(false);
    if (!v.ok) expect(v.message).toMatch(/must start at 0/);
  });

  it('refuses an open top end anywhere but the top', () => {
    const v = validateSlabs([slab('0', null, '0'), slab('100000', null, '2')]);
    expect(v.ok).toBe(false);
    if (!v.ok) expect(v.message).toMatch(/only the highest slab/i);
  });

  it('refuses an empty scheme rather than paying nobody anything', () => {
    expect(validateSlabs([]).ok).toBe(false);
  });
});
