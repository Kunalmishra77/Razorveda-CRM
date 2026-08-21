import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import {
  EXCEPTION_STATUSES,
  isException,
  validateRow,
  type RowContext,
  type RowStatus,
} from '../src/ingestion/validate-row.js';

/**
 * Phase 2 exit criterion 1: "every fixture parses to spec — counts match
 * fixtures/README.md".
 *
 * The headline test walks `edge_cases.csv` end to end and asserts the exact
 * row-by-row table in fixtures/README: **4 VALID · 4 PARKED · 2 ERROR**.
 */

const read = (name: string): string[][] =>
  readFileSync(fileURLToPath(new URL(`../../../fixtures/${name}`, import.meta.url)), 'utf8')
    .split(/\r?\n/)
    .filter((l) => l.trim())
    .map((l) => l.split(','));

/** MRP by product text, resolved the way the SKU resolver will. From the seed. */
const SKU_MRP: ReadonlyMap<string, string> = new Map(
  readFileSync(fileURLToPath(new URL('../../../db/seed/skus.csv', import.meta.url)), 'utf8')
    .split(/\r?\n/)
    .slice(1)
    .filter((l) => l.trim())
    .flatMap((line) => {
      const cells = line.split(',');
      const name = (cells[1] ?? '').toLowerCase();
      const mrp = cells[5] ?? '';
      const aliases = (line.match(/"([^"]*)"/)?.[1] ?? '').split('|').filter(Boolean);
      return [
        [name, mrp] as const,
        ...aliases.map((a) => [a.trim().toLowerCase(), mrp] as const),
      ];
    }),
);

const mrpFor = (productText: string | undefined): string | null => {
  const t = (productText ?? '').trim().toLowerCase();
  return SKU_MRP.get(t) ?? null;
};

const TODAY = '2026-08-21';

const ctx = (over: Partial<RowContext> = {}): RowContext => ({
  requiredFields: ['phone'],
  dateLocale: 'DMY',
  todayIso: TODAY,
  ...over,
});

describe('edge_cases.csv — the exact expectation table', () => {
  // Date,Name,Number,Alt number,Product detail,Amount,Payment Mode,status
  const rows = read('edge_cases.csv').slice(1);

  const verdicts = rows.map((r) => ({
    name: r[1] as string,
    verdict: validateRow(
      {
        date: r[0], name: r[1], phone: r[2], altPhone: r[3],
        productText: r[4], amount: r[5], paymentMode: r[6],
      },
      ctx({ skuMrp: mrpFor(r[4]) }),
    ),
  }));

  it.each([
    ['Valid Customer One', 'VALID'],
    ['No Phone At All', 'PARKED'],
    ['Literal Text Phone', 'PARKED'],
    ['Float Phone', 'VALID'],
    ['Nine Digit Phone', 'PARKED'],
    ['Eleven Digit Zero', 'VALID'],
    ['Landline Prefix', 'PARKED'],
    ['Insane Value', 'ERROR'],
    ['Future Date Row', 'ERROR'],
    ['Shared Alt Number', 'VALID'],
  ])('%s is %s', (name, expected) => {
    const found = verdicts.find((v) => v.name === name);
    expect(found, `row "${name}" missing from the fixture`).toBeDefined();
    expect(found?.verdict.status, JSON.stringify(found?.verdict.issues)).toBe(expected);
  });

  it('totals 4 VALID, 4 PARKED, 2 ERROR', () => {
    const tally = verdicts.reduce<Record<string, number>>((acc, v) => {
      acc[v.verdict.status] = (acc[v.verdict.status] ?? 0) + 1;
      return acc;
    }, {});
    expect(tally).toEqual({ VALID: 4, PARKED: 4, ERROR: 2 });
  });

  it('gives every non-clean row a reason an admin can act on', () => {
    for (const { name, verdict } of verdicts) {
      if (verdict.status === 'VALID') continue;
      expect(verdict.issues.length, `${name} has a status but no reason`).toBeGreaterThan(0);
      for (const issue of verdict.issues) {
        expect(issue.message.length, `${name}: empty message`).toBeGreaterThan(15);
        expect(issue.message).not.toMatch(/something went wrong|invalid input/i);
      }
    }
  });

  it('normalises the phone on rows that survive', () => {
    expect(verdicts.find((v) => v.name === 'Float Phone')?.verdict.normalised.phone)
      .toBe('9876543211');
    expect(verdicts.find((v) => v.name === 'Eleven Digit Zero')?.verdict.normalised.phone)
      .toBe('9876543212');
  });
});

describe('value sanity — the mistyped zero', () => {
  it('rejects an amount more than ten times MRP', () => {
    // A single extra zero on a ₹1,450 product becomes ₹14,500 of employee credit.
    const v = validateRow({ phone: '9876543210', amount: '98400' }, ctx({ skuMrp: '1450' }));
    expect(v.status).toBe('ERROR');
    expect(v.issues[0]?.code).toBe('VALUE_SANITY');
    expect(v.issues[0]?.message).toMatch(/typo/i);
  });

  it('allows a legitimate large multi-unit order', () => {
    // 10x MRP is the line; a 5-pack order must pass.
    expect(validateRow({ phone: '9876543210', amount: '7250' }, ctx({ skuMrp: '1450' })).status)
      .toBe('VALID');
  });

  it('says nothing when the SKU did not resolve', () => {
    // No MRP means no opinion. Inventing a bound would reject real orders.
    expect(validateRow({ phone: '9876543210', amount: '98400' }, ctx()).status).toBe('VALID');
  });
});

describe('pincode and state consistency', () => {
  it('warns, never errors, on a mismatch', () => {
    // The client's Client Category column already holds PIN codes; geography is a
    // hint, not a gate, and blocking on it would reject good orders.
    const v = validateRow(
      { phone: '9876543210', pincode: '400070', state: 'Uttar Pradesh' },
      ctx(),
    );
    expect(v.status).toBe('WARNING');
    expect(v.issues[0]?.message).toContain('maharashtra');
  });

  it('accepts a matching pincode and state', () => {
    expect(validateRow({ phone: '9876543210', pincode: '400070', state: 'Maharashtra' }, ctx()).status)
      .toBe('VALID');
  });

  it('has NO opinion on a valid prefix it does not know', () => {
    // A partial reference table must stay silent where it does not know. A false
    // warning is worse than no warning — it trains admins to ignore the column.
    // 86xxxx is a real, structurally valid PIN that is simply not in the table.
    expect(validateRow({ phone: '9876543210', pincode: '861001', state: 'Nowhere' }, ctx()).status)
      .toBe('VALID');
  });

  it('flags an Army Postal Service PIN as a dispatch risk, not a typo', () => {
    // My first attempt used 999999 as an "unknown prefix" and it warned — which
    // sent me looking. A 9 prefix is not an unused zone: it is the Army Postal
    // Service. Rare, real, and many couriers will not deliver there, so it is a
    // dispatch problem waiting to happen rather than bad data. Flagged, never
    // rejected — a military family is still a customer.
    const v = validateRow({ phone: '9876543210', pincode: '999999' }, ctx());
    expect(v.status).toBe('WARNING');
    expect(v.issues[0]?.code).toBe('ARMY_POSTAL_PINCODE');
    expect(v.issues[0]?.message).toMatch(/courier/i);
  });

  it('warns on a malformed pincode', () => {
    expect(validateRow({ phone: '9876543210', pincode: '40007' }, ctx()).status).toBe('WARNING');
  });
});

describe('precedence between problems', () => {
  it('reports PARKED ahead of ERROR', () => {
    // An un-keyable row is un-keyable first: the admin's next action is to find a
    // number, not to fix the amount.
    const v = validateRow(
      { phone: 'code', amount: '98400', date: '27-08-26' },
      ctx({ skuMrp: '1450' }),
    );
    expect(v.status).toBe('PARKED');
    // The other problems are still recorded, just not the headline.
    expect(v.issues.map((i) => i.code)).toContain('VALUE_SANITY');
  });

  it('reports ERROR ahead of WARNING', () => {
    const v = validateRow(
      { phone: '9876543210', date: '27-08-26', pincode: '400070', state: 'Punjab' },
      ctx(),
    );
    expect(v.status).toBe('ERROR');
  });

  it('reports DUPLICATE ahead of WARNING', () => {
    const v = validateRow(
      { phone: '9876543210', pincode: '400070', state: 'Punjab' },
      ctx({ isDuplicate: true }),
    );
    expect(v.status).toBe('DUPLICATE');
  });
});

describe('what the admin actually sees', () => {
  it('treats everything except VALID as an exception', () => {
    expect(EXCEPTION_STATUSES).toEqual(['WARNING', 'ERROR', 'DUPLICATE', 'PARKED']);
    for (const s of EXCEPTION_STATUSES) expect(isException(s)).toBe(true);
    expect(isException('VALID')).toBe(false);
  });

  it('keeps the exception rate low enough for a 25-minute day', () => {
    // docs/06: ~5% exceptions on a 500-row day is ~26 rows. If a clean channel
    // ever exceeded that, the admin's day is the thing that breaks.
    const rows = read('shopify_orders_sample.csv').slice(1);
    const exceptions = rows.filter((r) => {
      const v = validateRow(
        { date: r[1], name: r[2], phone: r[3], productText: r[5], amount: r[6], paymentMode: r[8], pincode: r[12], state: r[11] },
        ctx({ skuMrp: mrpFor(r[5]) }),
      );
      return isException(v.status);
    });
    // fixtures/README: 1 warning in this file (the unparseable payment string).
    expect(exceptions).toHaveLength(1);
  });
});
