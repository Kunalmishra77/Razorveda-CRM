import { describe, it, expect } from 'vitest';
import { computeIncentive, IncentiveError, type Modifier, type Slab } from '../src/incentive/incentive.js';
import { scaleMoney } from '@razorveda/shared';

/**
 * Incentive engine (docs/03 §6).
 *
 * The values here are the PROPOSALS from docs/03, not the client's scheme (O-09),
 * so every test asserting a rupee figure is asserting that the arithmetic is
 * right, not that the amount is what anyone will be paid. `provisional` is
 * asserted alongside, because a correct number presented as final is the failure
 * that costs money.
 */

const SLABS: Slab[] = [
  { minValue: '100000.00', maxValue: '200000.00', percent: '2.00', isProvisional: true },
  { minValue: '200000.00', maxValue: '300000.00', percent: '3.00', isProvisional: true },
  { minValue: '300000.00', maxValue: null, percent: '4.00', isProvisional: true },
];

const MODIFIERS: Modifier[] = [
  { kind: 'DELIVERY_QUALITY', thresholdMin: '0.0000', thresholdMax: '0.0500', lineId: null, value: '1.15', isProvisional: true },
  { kind: 'DELIVERY_QUALITY', thresholdMin: '0.0500', thresholdMax: '0.2000', lineId: null, value: '1.00', isProvisional: true },
  { kind: 'DELIVERY_QUALITY', thresholdMin: '0.2000', thresholdMax: null, lineId: null, value: '0.75', isProvisional: true },
  { kind: 'PREPAID_BONUS', thresholdMin: '0.3000', thresholdMax: null, lineId: null, value: '0.50', isProvisional: true },
  { kind: 'REPEAT_BONUS', thresholdMin: '3', thresholdMax: null, lineId: null, value: '100.00', isProvisional: true },
];

const base = (over: Partial<Parameters<typeof computeIncentive>[0]> = {}) =>
  computeIncentive({
    realisedCredited: '150000.00',
    ordersDelivered: 100,
    ordersRto: 2,
    prepaidRatio: '0.1000',
    repeatOrders: 0,
    lineIds: [],
    slabs: SLABS,
    modifiers: MODIFIERS,
    ...over,
  });

describe('criterion 4 — a month computed by the system matches a manual calculation', () => {
  it('the worked example, reconciled by hand', () => {
    // By hand:
    //   realised credited          150,000.00
    //   slab (100k–200k)                2.00%
    //   prepaid ratio 40% > 30%        +0.50%
    //   effective                       2.50%
    //   150,000 × 2.50%             = 3,750.00
    //   RTO 2/102 = 1.96% -> ×1.15  = 4,312.50
    //   4 repeat orders × ₹100         +400.00
    //   payable                     = 4,712.50
    const r = base({ prepaidRatio: '0.4000', repeatOrders: 4 });

    expect(r.slabPercent).toBe('2.00');
    expect(r.prepaidBonusPercent).toBe('0.50');
    expect(r.effectivePercent).toBe('2.50');
    expect(r.rtoPercent).toBe('0.0196');
    expect(r.deliveryQualityMultiplier).toBe('1.15');
    expect(r.repeatBonus).toBe('400.00');
    expect(r.payable).toBe('4712.50');
  });

  it('every figure it produces is marked provisional until O-09 is answered', () => {
    // The whole point of the flag. An incentive statement that looks authoritative
    // and is not gets paid, and the correction is a conversation about money that
    // has already been promised.
    expect(base().provisional).toBe(true);
  });

  it('stops being provisional only when every row used is confirmed', () => {
    const confirmed = (s: { isProvisional: boolean }) => ({ ...s, isProvisional: false });
    const r = computeIncentive({
      realisedCredited: '150000.00', ordersDelivered: 100, ordersRto: 2,
      prepaidRatio: '0.1000', repeatOrders: 0, lineIds: [],
      slabs: SLABS.map(confirmed) as Slab[],
      modifiers: MODIFIERS.map(confirmed) as Modifier[],
    });
    expect(r.provisional).toBe(false);
  });
});

describe('the slab', () => {
  it('picks the band the realised credit falls in', () => {
    expect(base({ realisedCredited: '250000.00' }).slabPercent).toBe('3.00');
    expect(base({ realisedCredited: '500000.00' }).slabPercent).toBe('4.00');
  });

  it('treats the boundary as the START of the higher band, not the end of the lower', () => {
    // 200,000 exactly is 3%, not 2%. Getting this backwards underpays every rep
    // who lands on a round number, which is disproportionately many.
    expect(base({ realisedCredited: '200000.00' }).slabPercent).toBe('3.00');
  });

  it('REFUSES when no slab covers the value, rather than paying zero', () => {
    // A missing slab is a configuration gap. Paying 0% silently would look like a
    // calculation and would be believed.
    expect(() => base({ realisedCredited: '50000.00' })).toThrow(IncentiveError);
    expect(() => base({ realisedCredited: '50000.00' })).toThrow(/Add a slab/);
  });
});

describe('delivery quality', () => {
  it('rewards under 5% RTO', () => {
    expect(base({ ordersDelivered: 100, ordersRto: 2 }).deliveryQualityMultiplier).toBe('1.15');
  });

  it('is neutral between 5% and 20%', () => {
    expect(base({ ordersDelivered: 90, ordersRto: 10 }).deliveryQualityMultiplier).toBe('1.00');
  });

  it('penalises above 20%', () => {
    expect(base({ ordersDelivered: 70, ordersRto: 30 }).deliveryQualityMultiplier).toBe('0.75');
  });

  it('measures RTO over orders that SHIPPED, not orders booked', () => {
    // docs/03 §3. Including never-dispatched orders would let a rep improve her
    // delivery quality by booking orders that are cancelled before dispatch.
    expect(base({ ordersDelivered: 100, ordersRto: 0 }).rtoPercent).toBe('0.0000');
    expect(base({ ordersDelivered: 0, ordersRto: 0 }).rtoPercent).toBe('0.0000');
  });
});

describe('a period that goes backwards', () => {
  it('pays zero when clawbacks exceed realisations — never a negative', () => {
    const r = base({ realisedCredited: '-5000.00' });
    expect(r.payable).toBe('0.00');
    expect(r.notes[0]).toMatch(/not carried forward/);
  });

  it('does not carry the shortfall into the next period', () => {
    // Cash basis (metric dictionary §7). Carrying it would mean a rep works a
    // clean month and is paid nothing because of a previous month's returns —
    // and would make a closed period's figure change after the fact.
    expect(base({ realisedCredited: '-5000.00' }).base).toBe('-5000.00');
    expect(base({ realisedCredited: '150000.00' }).payable).not.toBe('0.00');
  });
});

describe('rounding happens once — through computeIncentive, not just scaleMoney', () => {
  /**
   * A mutation check found this gap. Replacing the single chained multiply inside
   * `computeIncentive` with two rounded steps broke NOTHING: the worked example
   * above uses 150,000 x 2.50% x 1.15, and those round identically either way.
   *
   * The `scaleMoney` tests below prove the primitive is right. They said nothing
   * about whether the incentive engine USES it correctly, which is the part that
   * reaches a payslip.
   */
  it('catches a double round inside the engine itself', () => {
    // 333.33 x 3.33% x 1.15 -> 12.76 rounded once, 12.77 rounded twice.
    const d = computeIncentive({
      realisedCredited: '333.33',
      ordersDelivered: 100,
      ordersRto: 2,
      prepaidRatio: '0.0000',
      repeatOrders: 0,
      lineIds: [],
      slabs: [{ minValue: '0', maxValue: null, percent: '3.33', isProvisional: false }],
      modifiers: [{
        kind: 'DELIVERY_QUALITY', thresholdMin: '0.0000', thresholdMax: '0.0500',
        lineId: null, value: '1.15', isProvisional: false,
      }],
    });
    expect(d.effectivePercent).toBe('3.33');
    expect(d.deliveryQualityMultiplier).toBe('1.15');
    expect(d.payable).toBe('12.76');
    // Stated as the wrong answer, so the intent survives a refactor: 12.77 is
    // what two rounding steps produce, and it must never be what a rep is paid.
    expect(d.payable).not.toBe('12.77');
  });
});

describe('rounding happens once', () => {
  it('differs from rounding twice — with the cases that prove it', () => {
    // Not hypothetical. These are real divergences, found by searching for them:
    //
    //   333.33 x 3.33% x 1.15   once 12.76   rounded twice 12.77
    //   777.77 x 1.11% x 1.15   once  9.93   rounded twice  9.92
    //
    // A rupee either way per rep per month is small and it is also exactly the
    // kind of discrepancy that destroys trust in a payslip, because the rep can
    // do the sum herself and get a different answer.
    const once = (x: string, p: string, m: string) => scaleMoney(x, [p, '0.01', m]);
    const twice = (x: string, p: string, m: string) => scaleMoney(scaleMoney(x, [p, '0.01']), [m]);

    expect(once('333.33', '3.33', '1.15')).toBe('12.76');
    expect(twice('333.33', '3.33', '1.15')).toBe('12.77');

    expect(once('777.77', '1.11', '1.15')).toBe('9.93');
    expect(twice('777.77', '1.11', '1.15')).toBe('9.92');
  });

  it('is exact for values a float would corrupt', () => {
    // 0.1 + 0.2 territory. A float multiply here shows up as a rupee missing from
    // one rep's payslip and an extra rupee on another's.
    expect(scaleMoney('0.10', ['3'])).toBe('0.30');
    expect(scaleMoney('1000000.05', ['2.00', '0.01'])).toBe('20000.00');
  });
});
