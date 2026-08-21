import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import {
  SHIFT_FAILURE_THRESHOLD,
  describeShift,
  detectColumnShift,
  type ColumnCheck,
} from '../src/normalise/column-shift.js';
import type { TypeContract } from '../src/normalise/type-contracts.js';

/**
 * Phase 2 exit criterion 3: `corrupted_column_shift.csv` must be rejected as
 * SHIFTED with zero rows staged.
 *
 * Finding F3, and the reason it survived for months: every individual row looked
 * plausible. Only the shape of a whole column gives it away.
 */

const TODAY = '2026-08-21';

const csv = (name: string): string[][] =>
  readFileSync(fileURLToPath(new URL(`../../../fixtures/${name}`, import.meta.url)), 'utf8')
    .split(/\r?\n/)
    .filter((l) => l.trim())
    .map((l) => l.split(','));

const column = (rows: string[][], header: string): string[] => {
  const idx = (rows[0] ?? []).indexOf(header);
  if (idx === -1) throw new Error(`column ${header} not in fixture`);
  return rows.slice(1).map((r) => r[idx] ?? '');
};

/** The closed disposition vocabulary, as the mapper would supply it. */
const STATUS_VALUES = [
  'order done', 'follow up', 'call back', 'interested', 'ringing', 'busy',
  'not connected', 'switched off', 'cod', 'delivered', 'refused', 'no response',
];

const check = (
  rows: string[][],
  header: string,
  targetField: string,
  contract: TypeContract,
): ColumnCheck => ({ column: header, targetField, contract, values: column(rows, header) });

describe('the corrupted fixture is rejected — exit criterion 3', () => {
  const rows = csv('corrupted_column_shift.csv');

  const columns: ColumnCheck[] = [
    check(rows, 'Date', 'order_date', { kind: 'DATE', locale: 'DMY' }),
    check(rows, 'Number', 'primary_phone', { kind: 'PHONE' }),
    check(rows, 'Amount', 'final_value', { kind: 'MONEY', min: 1 }),
    check(rows, 'Order Status', 'current_status', { kind: 'ENUM', allowed: STATUS_VALUES }),
    check(rows, 'Client Category', 'customer_category', { kind: 'FREE_TEXT' }),
    check(rows, 'Data Resource', 'source_note', { kind: 'FREE_TEXT' }),
    check(rows, 'Agent', 'caller_name', { kind: 'FREE_TEXT' }),
  ];

  const result = detectColumnShift(columns, TODAY);

  it('marks the batch SHIFTED', () => {
    expect(result.shifted).toBe(true);
  });

  it('catches Order Status holding customer names', () => {
    // "Order Status contains 40+ customer names" — F3, verbatim.
    const status = result.offenders.find((o) => o.column === 'Order Status');
    expect(status, 'the enum column did not fail').toBeDefined();
    expect(status?.reason).toBe('TYPE_MISMATCH');
    expect(status?.failureRate).toBe(1);
    expect(status?.sample[0]).toBe('Tapas Mandal');
  });

  it('catches Client Category holding PIN codes — the column B10 was blind to', () => {
    // A free-text column cannot fail a type check, so the ordinary detector never
    // sees this. "Client Category contains PIN codes (247232, 440023)" — F3.
    const category = result.offenders.find((o) => o.column === 'Client Category');
    expect(category, 'the free-text heuristic did not fire').toBeDefined();
    expect(category?.reason).toBe('FREE_TEXT_LOOKS_STRUCTURED');
    expect(category?.sample).toContain('247232');
  });

  it('catches Data Resource holding AWB numbers', () => {
    const resource = result.offenders.find((o) => o.column === 'Data Resource');
    expect(resource?.reason).toBe('FREE_TEXT_LOOKS_STRUCTURED');
  });

  it('leaves the genuinely free-text Agent column alone', () => {
    // Rep names are words. Flagging this too would train admins to ignore the alert.
    expect(result.offenders.find((o) => o.column === 'Agent')).toBeUndefined();
  });

  it('does not blame columns that are actually fine', () => {
    // Date, Number and Amount did not shift in this fixture, and saying they did
    // would send the admin looking in the wrong place.
    for (const clean of ['Date', 'Number', 'Amount']) {
      expect(result.offenders.find((o) => o.column === clean), `${clean} wrongly blamed`)
        .toBeUndefined();
    }
  });

  it('explains itself in words an admin can act on', () => {
    const message = describeShift(result);
    expect(message).toContain('columns have shifted');
    expect(message).toContain('nothing was imported');
    expect(message).toContain('Order Status');
    expect(message).toContain('Nothing has changed');
    expect(message).not.toMatch(/something went wrong/i);
  });
});

describe('a clean file is not rejected', () => {
  it('passes the shopify fixture', () => {
    // The detector is worthless if it cries shift on good files: an admin who
    // learns to click through the warning has lost the whole control.
    const rows = csv('shopify_orders_sample.csv');
    const result = detectColumnShift(
      [
        check(rows, 'Date', 'order_date', { kind: 'DATE', locale: 'DMY' }),
        check(rows, 'Phone no', 'primary_phone', { kind: 'PHONE' }),
        check(rows, 'Total amount', 'final_value', { kind: 'MONEY', min: 1 }),
        check(rows, 'Pincode', 'ship_pincode', { kind: 'PINCODE' }),
        check(rows, 'CustomerName', 'full_name', { kind: 'FREE_TEXT' }),
        check(rows, 'City', 'city', { kind: 'FREE_TEXT' }),
      ],
      TODAY,
    );
    expect(result.shifted, describeShift(result)).toBe(false);
  });

  it('passes the meta ads fixture, +91 prefixes and all', () => {
    const rows = csv('meta_ads_sample.csv');
    const result = detectColumnShift(
      [
        check(rows, 'phone_number', 'primary_phone', { kind: 'PHONE' }),
        check(rows, 'full_name', 'full_name', { kind: 'FREE_TEXT' }),
        check(rows, 'city', 'city', { kind: 'FREE_TEXT' }),
      ],
      TODAY,
    );
    expect(result.shifted, describeShift(result)).toBe(false);
  });
});

describe('the threshold behaves at its edges', () => {
  const enumContract: TypeContract = { kind: 'ENUM', allowed: ['cod', 'prepaid'] };
  const withFailures = (bad: number, total: number): ColumnCheck => ({
    column: 'Payment Mode',
    targetField: 'payment_mode',
    contract: enumContract,
    values: [
      ...Array.from({ length: bad }, () => 'Tapas Mandal'),
      ...Array.from({ length: total - bad }, () => 'cod'),
    ],
  });

  it('is 20%', () => {
    expect(SHIFT_FAILURE_THRESHOLD).toBe(0.2);
  });

  it('tolerates exactly 20% — the rule is MORE than 20%', () => {
    // 2 of 10 is ordinary dirty data, and the exception queue exists for it.
    expect(detectColumnShift([withFailures(2, 10)], TODAY).shifted).toBe(false);
  });

  it('rejects just above 20%', () => {
    expect(detectColumnShift([withFailures(3, 10)], TODAY).shifted).toBe(true);
  });

  it('ignores empty cells when computing the rate', () => {
    // A sparse column is a completeness problem, not a type problem. Counting
    // blanks as failures would reject every optional column.
    const sparse: ColumnCheck = {
      column: 'Alt number',
      targetField: 'alt_phone',
      contract: { kind: 'PHONE' },
      values: ['9876543210', '', '', '', ''],
    };
    expect(detectColumnShift([sparse], TODAY).shifted).toBe(false);
  });

  it('says nothing about a column with no values at all', () => {
    const empty: ColumnCheck = {
      column: 'Alt number',
      targetField: 'alt_phone',
      contract: { kind: 'PHONE' },
      values: ['', '', ''],
    };
    expect(detectColumnShift([empty], TODAY).shifted).toBe(false);
  });
});
