import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { sumMoney } from '@razorveda/shared';
import {
  AttributionError,
  computeAttribution,
  splitLineRevenue,
  type AttributionLine,
} from '../src/orders/attribution.js';

/**
 * Phase 1 exit criteria 5 and 6, plus the worked examples in docs/03 §4.
 *
 * Base prices are READ FROM db/seed/skus.csv, never hardcoded here. O-02 is still
 * open — the ₹899 / ₹849 / ₹949 clusters were reverse-engineered from the client's
 * order data — so when the client confirms the real numbers, the seed changes and
 * these tests follow it. A rupee amount typed into a test would silently become a
 * second source of truth for a money rule.
 */

const seed = readFileSync(
  fileURLToPath(new URL('../../../db/seed/skus.csv', import.meta.url)),
  'utf8',
);

interface SeedSku {
  skuCode: string;
  lineCode: string;
  basePrice: string | null;
}

const SKUS: SeedSku[] = seed
  .split(/\r?\n/)
  .slice(1)
  .filter((l) => l.trim())
  .map((line) => {
    // sku_code,product_name,line_code,variant,pack_size,mrp,shopify_base_price,...
    const cells = line.split(',');
    return {
      skuCode: cells[0] as string,
      lineCode: cells[2] as string,
      basePrice: (cells[6] ?? '') === '' ? null : (cells[6] as string),
    };
  });

const bySku = (code: string): SeedSku => {
  const s = SKUS.find((x) => x.skuCode === code);
  if (!s) throw new Error(`sku ${code} not in seed`);
  return s;
};

/** A Breast Care SKU that carries a Shopify base price. */
const BC = bySku('BC-014');
/** A Skinwise SKU that carries one. */
const SW = bySku('SW-007');

const cartLine = (s: SeedSku, quantity = 1): AttributionLine => ({
  skuId: s.skuCode,
  quantity,
  shopifyBasePrice: s.basePrice,
  isUpsell: false,
});

const upsellLine = (s: SeedSku, quantity = 1): AttributionLine => ({
  skuId: s.skuCode,
  quantity,
  shopifyBasePrice: s.basePrice,
  isUpsell: true,
});

describe('the seed still carries what these tests depend on', () => {
  it('BC-014 and SW-007 have a Shopify base price (O-02, provisional)', () => {
    expect(BC.basePrice, 'BC-014 lost its shopify_base_price').not.toBeNull();
    expect(SW.basePrice, 'SW-007 lost its shopify_base_price').not.toBeNull();
    expect(BC.lineCode).toBe('BREAST_CARE');
    expect(SW.lineCode).toBe('SKINWISE');
  });
});

describe('Phase 1 exit criterion 5 — Shopify upsell credit', () => {
  it('a ₹3,000 order on a base-priced SKU credits final minus base', () => {
    const r = computeAttribution({
      rule: 'UPSELL_DELTA',
      employeeCreditPercent: '100',
      finalValue: '3000.00',
      lines: [cartLine(BC)],
    });
    // With the seeded 899 this is 899 / 2101 — the criterion's numbers, derived
    // from the seed rather than asserted independently of it.
    expect(r.companyBaseValue).toBe(`${BC.basePrice}.00`);
    expect(r.employeeCreditedValue).toBe(
      sumMoney(['3000.00', `-${BC.basePrice}.00`]),
    );
    expect(r.ruleApplied).toBe('UPSELL_DELTA_SKU');
  });

  it('docs/03 worked example: Shopify ₹500 upsold to ₹2,000 → base 500, credit 1,500', () => {
    const r = computeAttribution({
      rule: 'UPSELL_DELTA',
      employeeCreditPercent: '100',
      finalValue: '2000.00',
      lines: [{ skuId: 'X', quantity: 1, shopifyBasePrice: '500.00', isUpsell: false }],
    });
    expect(r).toMatchObject({ companyBaseValue: '500.00', employeeCreditedValue: '1500.00' });
  });

  it('docs/03 worked example: WA campaign ₹700 upsold to ₹1,800 → base 700, credit 1,100', () => {
    const r = computeAttribution({
      rule: 'UPSELL_DELTA',
      employeeCreditPercent: '100',
      finalValue: '1800.00',
      lines: [],
      importedOrderValue: '700.00',
    });
    expect(r).toMatchObject({
      companyBaseValue: '700.00',
      employeeCreditedValue: '1100.00',
      ruleApplied: 'UPSELL_DELTA_IMPORTED',
    });
  });

  it('counts only NON-upsell lines toward the company base', () => {
    // The rep added the Skinwise item, so it is earned, not committed.
    const r = computeAttribution({
      rule: 'UPSELL_DELTA',
      employeeCreditPercent: '100',
      finalValue: '3000.00',
      lines: [cartLine(BC), upsellLine(SW)],
    });
    expect(r.companyBaseValue).toBe(`${BC.basePrice}.00`);
  });

  it('multiplies the base by quantity', () => {
    const r = computeAttribution({
      rule: 'UPSELL_DELTA',
      employeeCreditPercent: '100',
      finalValue: '5000.00',
      lines: [cartLine(BC, 2)],
    });
    expect(r.companyBaseValue).toBe(sumMoney([`${BC.basePrice}.00`, `${BC.basePrice}.00`]));
  });
});

describe('the F7 leak is unreachable, not merely discouraged', () => {
  it('REFUSES to compute when a cart line has no base price', () => {
    // Defaulting to zero here would credit the rep the whole order value — F7
    // reproduced faithfully in code. Failing loudly sends it to the exception
    // queue where a human decides.
    const noBase: AttributionLine = {
      skuId: 'BC-015',
      quantity: 1,
      shopifyBasePrice: null,
      isUpsell: false,
    };
    expect(() =>
      computeAttribution({
        rule: 'UPSELL_DELTA',
        employeeCreditPercent: '100',
        finalValue: '2500.00',
        lines: [noBase],
      }),
    ).toThrow(AttributionError);
  });

  it('explains what to do about it', () => {
    try {
      computeAttribution({
        rule: 'UPSELL_DELTA',
        employeeCreditPercent: '100',
        finalValue: '2500.00',
        lines: [{ skuId: 'BC-015', quantity: 1, shopifyBasePrice: null, isUpsell: false }],
      });
      expect.unreachable('should have thrown');
    } catch (e) {
      const m = (e as Error).message;
      expect(m).toContain('BC-015');
      expect(m).toMatch(/set the base price|mark the line as an upsell/i);
      expect(m).toContain('F7');
    }
  });

  it('tolerates an upsell-only order with no committed cart', () => {
    // A rep-created order against a Shopify lead that arrived without a cart.
    const r = computeAttribution({
      rule: 'UPSELL_DELTA',
      employeeCreditPercent: '100',
      finalValue: '1450.00',
      lines: [upsellLine(BC)],
    });
    expect(r).toMatchObject({ companyBaseValue: '0.00', employeeCreditedValue: '1450.00' });
  });

  it('clamps rather than paying a negative credit', () => {
    // The rep discounted below the committed cart. A clawback is a ledger event,
    // not an arithmetic accident.
    const r = computeAttribution({
      rule: 'UPSELL_DELTA',
      employeeCreditPercent: '100',
      finalValue: '500.00',
      lines: [{ skuId: 'X', quantity: 1, shopifyBasePrice: '899.00', isUpsell: false }],
    });
    expect(r.companyBaseValue).toBe('500.00');
    expect(r.employeeCreditedValue).toBe('0.00');
    expect(r.ruleApplied).toContain('CLAMPED');
  });
});

describe('FULL_CREDIT sources', () => {
  it('credits the whole value with a zero base', () => {
    const r = computeAttribution({
      rule: 'FULL_CREDIT',
      employeeCreditPercent: '100',
      finalValue: '1450.00',
      lines: [cartLine(BC)],
    });
    // Even with a base-priced SKU present: META_ADS is not an upsell source.
    expect(r).toMatchObject({ companyBaseValue: '0.00', employeeCreditedValue: '1450.00' });
  });

  it('applies employee_credit_percent when it is not 100 (O-11)', () => {
    // Seeded 100 everywhere in v1, so this is a no-op today — but it is a seed
    // value, and changing it must never require a code change.
    const r = computeAttribution({
      rule: 'FULL_CREDIT',
      employeeCreditPercent: '50',
      finalValue: '1000.00',
      lines: [],
    });
    expect(r.employeeCreditedValue).toBe('500.00');
  });
});

describe('credit splits — the "Riya / Divya" case', () => {
  it('splits 60/40 with no rounding loss', () => {
    const r = computeAttribution({
      rule: 'FULL_CREDIT',
      employeeCreditPercent: '100',
      finalValue: '2101.00',
      lines: [],
      splits: [
        { employeeId: 'riya', percent: '60' },
        { employeeId: 'divya', percent: '40' },
      ],
    });
    expect(r.perEmployee).toEqual([
      { employeeId: 'riya', creditedValue: '1260.60' },
      { employeeId: 'divya', creditedValue: '840.40' },
    ]);
    expect(sumMoney(r.perEmployee.map((p) => p.creditedValue))).toBe(r.employeeCreditedValue);
  });

  it('always re-sums to the credited value, including awkward thirds', () => {
    const r = computeAttribution({
      rule: 'FULL_CREDIT',
      employeeCreditPercent: '100',
      finalValue: '1000.00',
      lines: [],
      splits: [
        { employeeId: 'a', percent: '33.33' },
        { employeeId: 'b', percent: '33.33' },
        { employeeId: 'c', percent: '33.34' },
      ],
    });
    expect(sumMoney(r.perEmployee.map((p) => p.creditedValue))).toBe('1000.00');
  });

  it('rejects percentages that do not sum to 100', () => {
    expect(() =>
      computeAttribution({
        rule: 'FULL_CREDIT',
        employeeCreditPercent: '100',
        finalValue: '1000.00',
        lines: [],
        splits: [
          { employeeId: 'a', percent: '60' },
          { employeeId: 'b', percent: '30' },
        ],
      }),
    ).toThrow(/sum to exactly 100/);
  });
});

describe('Phase 1 exit criterion 6 — product line revenue splits from lines (F8)', () => {
  it('splits a two-line order across Breast Care and Skinwise', () => {
    // The exact defect: the client's Achieve Report shows Skinwise = ₹0 for all
    // 11 BDEs against ₹2,51,698 of actual sales, because product was one column.
    const revenue = splitLineRevenue([
      { lineId: 'l1', lineValue: '1450.00', productLine: BC.lineCode },
      { lineId: 'l2', lineValue: '1200.00', productLine: SW.lineCode },
    ]);
    expect(revenue.get('BREAST_CARE')).toBe('1450.00');
    expect(revenue.get('SKINWISE')).toBe('1200.00');
    expect(sumMoney([...revenue.values()])).toBe('2650.00');
  });

  it('accumulates several lines of the same product line', () => {
    const revenue = splitLineRevenue([
      { lineId: 'l1', lineValue: '1450.00', productLine: 'BREAST_CARE' },
      { lineId: 'l2', lineValue: '1500.00', productLine: 'BREAST_CARE' },
      { lineId: 'l3', lineValue: '999.00', productLine: 'SKINWISE' },
    ]);
    expect(revenue.get('BREAST_CARE')).toBe('2950.00');
    expect(revenue.get('SKINWISE')).toBe('999.00');
  });

  it('never reports zero for a line that actually sold', () => {
    const revenue = splitLineRevenue([
      { lineId: 'l1', lineValue: '0.01', productLine: 'SKINWISE' },
    ]);
    expect(revenue.get('SKINWISE')).not.toBe('0.00');
  });
});
