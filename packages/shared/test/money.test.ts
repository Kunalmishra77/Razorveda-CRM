import { describe, it, expect } from 'vitest';
import {
  addMoney, cmpMoney, fromScaled, isNegativeMoney, money, mulQuantity,
  percentOfMoney, splitMoney, subMoney, sumMoney, toScaled,
} from '../src/money.js';

/**
 * D-29 and D-39. Every assertion here has a float counterpart that would fail,
 * which is the point: these are not arithmetic tests, they are proof that the
 * arithmetic never becomes floating point.
 */

describe('parsing and formatting', () => {
  it('normalises to 2dp', () => {
    expect(money('1450')).toBe('1450.00');
    expect(money('1450.5')).toBe('1450.50');
    expect(money('0')).toBe('0.00');
    expect(money('-899.5')).toBe('-899.50');
  });

  it('rounds half-up on the third decimal, like Postgres numeric', () => {
    expect(money('10445.045')).toBe('10445.05');
    expect(money('10445.044')).toBe('10445.04');
    expect(money('-1.005')).toBe('-1.01');
  });

  it('rejects anything that is not a money string', () => {
    for (const bad of ['', 'abc', '1,450', '1450px', 'NaN', 'Infinity', '1e3']) {
      expect(() => money(bad), `accepted ${JSON.stringify(bad)}`).toThrow(/not a money string/);
    }
  });

  it('rejects a JS number outright', () => {
    // The type system says string, but data crosses boundaries at runtime.
    expect(() => money(1450 as unknown as string)).toThrow(/not a money string/);
  });

  it('round-trips through the scaled representation', () => {
    for (const v of ['0.00', '0.01', '1450.00', '999999999.99', '-2500.50']) {
      expect(fromScaled(toScaled(v))).toBe(v);
    }
  });
});

describe('arithmetic that floats get wrong', () => {
  it('adds without drift', () => {
    // 0.1 + 0.2 === 0.30000000000000004
    expect(addMoney('0.10', '0.20')).toBe('0.30');
    expect(addMoney('1450.00', '1050.00')).toBe('2500.00');
  });

  it('subtracts without drift — this is the F7 credit calculation', () => {
    // Phase 1 exit criterion 5, in miniature.
    expect(subMoney('3000.00', '899.00')).toBe('2101.00');
    expect(subMoney('2000.00', '500.00')).toBe('1500.00');
    expect(subMoney('1800.00', '700.00')).toBe('1100.00');
  });

  it('multiplies by quantity without drift', () => {
    // 1450.10 * 3 === 4350.299999999999 in floating point
    expect(mulQuantity('1450.10', 3)).toBe('4350.30');
    expect(mulQuantity('0.07', 3)).toBe('0.21');
  });

  it('refuses a fractional quantity', () => {
    // F9: order counts are integers, always. A fractional quantity is the same
    // defect one level down.
    expect(() => mulQuantity('1450.00', 1.5)).toThrow(/must be an integer/);
  });

  it('takes a percentage without drift', () => {
    // 2500 * 1.15 === 2874.9999999999995
    expect(percentOfMoney('2500.00', '115')).toBe('2875.00');
    expect(percentOfMoney('100000.00', '2')).toBe('2000.00');
    expect(percentOfMoney('1000.00', '33.33')).toBe('333.30');
  });

  it('sums a list exactly', () => {
    const lines = ['1450.00', '1200.00', '899.00', '0.01'];
    expect(sumMoney(lines)).toBe('3549.01');
    expect(sumMoney([])).toBe('0.00');
  });

  it('compares without float surprises', () => {
    expect(cmpMoney('1450.00', '1450')).toBe(0);
    expect(cmpMoney('0.10', '0.09')).toBe(1);
    expect(isNegativeMoney('-0.01')).toBe(true);
  });
});

describe('splitMoney — an attribution ledger must always add up', () => {
  it('splits evenly', () => {
    expect(splitMoney('2000.00', ['60', '40'])).toEqual(['1200.00', '800.00']);
  });

  it('splits a three-way remainder with no paise lost or invented', () => {
    // Rounding each share independently gives 333.30 x3 = 999.90 and loses 10p.
    const parts = splitMoney('1000.00', ['33.33', '33.33', '33.34']);
    expect(sumMoney(parts)).toBe('1000.00');
  });

  it('always re-sums to the whole, across many awkward amounts', () => {
    // The property that matters. A ledger that does not add up is worse than one
    // that is a paisa unfair to one rep.
    for (const amount of ['0.01', '0.03', '1.00', '999.99', '1450.33', '123456.78']) {
      for (const percents of [['50', '50'], ['33.33', '33.33', '33.34'], ['70', '20', '10']]) {
        expect(sumMoney(splitMoney(amount, percents)), `${amount} / ${percents}`).toBe(
          money(amount),
        );
      }
    }
  });

  it('handles the client "Riya / Divya" two-rep case', () => {
    const parts = splitMoney('2101.00', ['50', '50']);
    expect(parts).toEqual(['1050.50', '1050.50']);
    expect(sumMoney(parts)).toBe('2101.00');
  });

  it('splits a negative amount — clawbacks are split too', () => {
    const parts = splitMoney('-1000.00', ['33.33', '33.33', '33.34']);
    expect(sumMoney(parts)).toBe('-1000.00');
  });

  it('refuses percentages that do not sum to exactly 100', () => {
    expect(() => splitMoney('1000.00', ['50', '49'])).toThrow(/sum to exactly 100/);
    expect(() => splitMoney('1000.00', ['50', '51'])).toThrow(/sum to exactly 100/);
    expect(() => splitMoney('1000.00', ['33.33', '33.33', '33.33'])).toThrow(/sum to exactly 100/);
  });
});
