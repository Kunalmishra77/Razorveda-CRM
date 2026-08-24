import { describe, expect, it } from 'vitest';
import { planPriceUpload, type CurrentSku, type UploadedPriceRow } from '../src/master/price-upload.js';

/**
 * The rules that stop a bulk price upload from quietly wrecking payroll.
 *
 * `shopify_base_price` decides `company_base_value`, which decides
 * `employee_credited_value`. A bad figure here does not throw — it silently
 * changes what every rep earns on that product, in the direction nobody notices
 * until payday. The single-SKU screen has an admin looking at one number; an
 * upload has an admin looking at a filename.
 *
 * So each rule below has a test, and each test says which real mistake it catches.
 */

const SKUS: CurrentSku[] = [
  { skuId: 'a', skuCode: 'BC-001', productName: 'Breast Care 60', mrp: '1499.00', basePrice: '899.00', confirmed: true },
  { skuId: 'b', skuCode: 'SK-002', productName: 'Skinwise Gel', mrp: '999.00', basePrice: '849.00', confirmed: false },
  { skuId: 'c', skuCode: 'SL-003', productName: 'Slimming Care', mrp: '1299.00', basePrice: null, confirmed: false },
];

const plan = (rows: UploadedPriceRow[]) => planPriceUpload(rows, SKUS);
const only = (rows: UploadedPriceRow[]) => plan(rows).verdicts[0]!;

describe('a price that would make the rep lose money', () => {
  it('is refused above MRP, not clamped', () => {
    // The company would have committed more than the customer pays, so
    // final_value - company_base_value is negative. Clamping to MRP would produce
    // a plausible number from a typo and pay someone on it.
    const v = only([{ skuCode: 'BC-001', basePrice: '1600' }]);
    expect(v.kind).toBe('REJECTED');
    expect(v.kind === 'REJECTED' && v.reason).toMatch(/more than the 1499.00 MRP/);
    expect(v.kind === 'REJECTED' && v.reason).toMatch(/negative/);
  });

  it('is refused at exactly zero, which would credit her the whole order', () => {
    // Zero is the F7 defect: the entire order value becomes employee credit.
    const v = only([{ skuCode: 'BC-001', basePrice: '0' }]);
    expect(v.kind).toBe('REJECTED');
  });

  it('accepts a price exactly equal to MRP — zero credit is legitimate', () => {
    // Not an error. It means the company committed the whole sale, so the rep
    // earns nothing on it, which is a real commercial situation and not a typo.
    const v = only([{ skuCode: 'BC-001', basePrice: '1499' }]);
    expect(v.kind).toBe('ACCEPTED');
  });
});

describe('the typo that MRP alone does not catch', () => {
  it('warns on a large move rather than rejecting it', () => {
    // 899 -> 449 is under MRP and passes every other rule, but halves what the
    // company is deemed to have committed and doubles the rep's credit. Warned,
    // not blocked: a genuine 50% cut happens, and refusing it would send the
    // admin to the one-at-a-time screen to do exactly what the upload refused.
    const v = only([{ skuCode: 'BC-001', basePrice: '449' }]);
    expect(v.kind).toBe('ACCEPTED');
    expect(v.kind === 'ACCEPTED' && v.warning).toMatch(/50\.1% change|usually a typo/);
    expect(plan([{ skuCode: 'BC-001', basePrice: '449' }]).needsAcknowledgement).toBe(1);
  });

  it('does not warn on an ordinary adjustment', () => {
    // 899 -> 949 is 5.6%. Warning on this would train the admin to click through
    // every warning, which is how the 10x typo gets waved past.
    const v = only([{ skuCode: 'BC-001', basePrice: '949' }]);
    expect(v.kind).toBe('ACCEPTED');
    expect(v.kind === 'ACCEPTED' && v.warning).toBeUndefined();
    expect(plan([{ skuCode: 'BC-001', basePrice: '949' }]).needsAcknowledgement).toBe(0);
  });

  it('does not warn when replacing a price nobody ever confirmed', () => {
    // SK-002's 849 is reverse-engineered from order data (O-02), not a price
    // anyone stands behind. Replacing it is the whole point of the exercise, so a
    // large move is expected rather than suspicious.
    const v = only([{ skuCode: 'SK-002', basePrice: '300' }]);
    expect(v.kind).toBe('ACCEPTED');
    expect(v.kind === 'ACCEPTED' && v.warning).toBeUndefined();
  });

  it('reports the change percent so the admin can see the size of it', () => {
    const v = only([{ skuCode: 'BC-001', basePrice: '999' }]);
    expect(v.kind === 'ACCEPTED' && v.changePercent).toBe('11.1');
  });

  it('has no change percent when there was no prior price', () => {
    // Not "0%" and not "100%". There is no previous number to compare against,
    // and inventing one would put a meaningless figure in front of a decision.
    const v = only([{ skuCode: 'SL-003', basePrice: '700' }]);
    expect(v.kind === 'ACCEPTED' && v.changePercent).toBeNull();
  });
});

describe('rows that cannot be applied', () => {
  it('rejects an unknown product code instead of skipping it', () => {
    // Silently skipping means the admin believes 40 prices landed when 39 did.
    // An unknown code usually means the file is from another catalogue.
    const v = only([{ skuCode: 'NOPE-9', basePrice: '500' }]);
    expect(v.kind).toBe('REJECTED');
    expect(v.kind === 'REJECTED' && v.reason).toMatch(/no active product with the code NOPE-9/);
  });

  it('rejects BOTH copies when a SKU appears twice', () => {
    // Taking the last one makes the applied price depend on row order, which is
    // not something an admin can see in a spreadsheet.
    const p = plan([
      { skuCode: 'BC-001', basePrice: '900' },
      { skuCode: 'BC-001', basePrice: '1000' },
    ]);
    expect(p.rejected).toBe(2);
    expect(p.accepted).toBe(0);
  });

  it('rejects text where a price should be', () => {
    for (const bad of ['', 'nine hundred', '1,499', '499.999', '-500']) {
      expect(only([{ skuCode: 'BC-001', basePrice: bad }]).kind, `"${bad}" was accepted`).toBe('REJECTED');
    }
  });

  it('rejects a row with no product code', () => {
    expect(only([{ skuCode: '   ', basePrice: '500' }]).kind).toBe('REJECTED');
  });

  it('one bad row does not abandon the good ones', () => {
    // An admin with 3 rows and 1 unknown code should be able to apply the 2.
    const p = plan([
      { skuCode: 'BC-001', basePrice: '950' },
      { skuCode: 'NOPE-9', basePrice: '500' },
      { skuCode: 'SL-003', basePrice: '700' },
    ]);
    expect(p.accepted).toBe(2);
    expect(p.rejected).toBe(1);
  });
});

describe('rows that are already correct', () => {
  it('an identical confirmed price is UNCHANGED, not a pointless write', () => {
    // Rewriting it would stamp a new set_by/set_at and an audit row saying an
    // admin changed something they did not, which makes the audit trail noisier
    // and less trustworthy at exactly the point someone consults it.
    const v = only([{ skuCode: 'BC-001', basePrice: '899.00' }]);
    expect(v.kind).toBe('UNCHANGED');
  });

  it('an identical but UNCONFIRMED price is still applied', () => {
    // The number matches, but nobody has vouched for it. Applying it is what
    // turns a reverse-engineered guess into a confirmed figure, which is the
    // difference between an order being parked and being credited.
    const v = only([{ skuCode: 'SK-002', basePrice: '849.00' }]);
    expect(v.kind).toBe('ACCEPTED');
  });

  it('counts add up to the file the admin sent', () => {
    const rows = [
      { skuCode: 'BC-001', basePrice: '899.00' },
      { skuCode: 'SK-002', basePrice: '800' },
      { skuCode: 'NOPE-9', basePrice: '500' },
    ];
    const p = plan(rows);
    expect(p.accepted + p.unchanged + p.rejected).toBe(rows.length);
  });
});

describe('codes as they actually arrive', () => {
  it('matches case-insensitively and ignores surrounding spaces', () => {
    // Exported spreadsheets carry trailing spaces and inconsistent case, and the
    // client's real files are the ones described in CLAUDE.md section 6.
    expect(only([{ skuCode: '  bc-001 ', basePrice: '950' }]).kind).toBe('ACCEPTED');
  });

  it('still catches a duplicate that differs only by case or spacing', () => {
    const p = plan([
      { skuCode: 'BC-001', basePrice: '900' },
      { skuCode: ' bc-001', basePrice: '1000' },
    ]);
    expect(p.rejected, 'a case-different duplicate slipped through').toBe(2);
  });
});

describe('an empty upload', () => {
  it('is not an error, and applies nothing', () => {
    const p = plan([]);
    expect(p.accepted).toBe(0);
    expect(p.rejected).toBe(0);
    expect(p.verdicts).toEqual([]);
  });
});
