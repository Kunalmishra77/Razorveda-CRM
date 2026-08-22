import { describe, it, expect } from 'vitest';
import {
  computeTargets, targetMovementPercent, LEGACY_FLAT_UPLIFT, RTO_CAP_FOR_TARGETS,
} from '../src/reports/targets.js';

/**
 * Target arithmetic (docs/03 §2, §8; F11).
 *
 * The tests that matter are the ones showing WHO the flat ×1.15 was wrong for,
 * because that is the argument the client has to accept before the corrected
 * figure can be switched on.
 */

const base = (over: Partial<Parameters<typeof computeTargets>[0]> = {}) =>
  computeTargets({
    monthlyTarget: '300000.00',
    realisedValue: '146230.61',
    remainingWorkingDays: 12,
    elapsedWorkingDays: 14,
    rollingRto: 0.13,
    shippedOrders: 40,
    teamRollingRto: 0.12,
    ...over,
  });

describe('the parts docs/03 marks as already correct', () => {
  it('Value Balance is Target minus Realised, reproduced exactly', () => {
    expect(base().valueBalance).toBe('153769.39');
  });

  it('Per Day Req Delivery divides by working days from the calendar', () => {
    // D-34: the forward direction was verified against the client's own sheet to
    // five decimals on the 17 Aug 2026 snapshot. 153,769.39 / 12 = 12,814.115833.
    expect(base().perDayReqDelivery).toBe('12814.12');
  });

  it('Per Day Avg Value uses the CALENDAR divisor, not the hand-typed one', () => {
    // The client's sheet divides by 11. No calendar rule produces 11; working days
    // 1–17 August with Sundays off is 14 (D-34). Their method inflates the
    // run-rate by 27%, and the forecast is built on it.
    expect(base().perDayAvgValue).toBe('10445.04');
    const theirs = 146230.61 / 11;
    expect(theirs).toBeGreaterThan(Number(base().perDayAvgValue));
  });
});

describe('F11 — who the flat uplift was wrong for', () => {
  it('asks a LOW-RTO rep for less than the flat 1.15 did', () => {
    // 5% RTO: the rep loses one order in twenty, not three in twenty. The old
    // number had her booking more than she needed all month.
    const low = base({ rollingRto: 0.05 });
    expect(Number(low.requiredBookingCorrected)).toBeLessThan(Number(low.requiredBookingLegacy));
    expect(targetMovementPercent(low)!).toBeLessThan(0);
  });

  it('asks a HIGH-RTO rep for substantially more', () => {
    // 30% RTO: 1/(1-0.30) = 1.4286 against a flat 1.15. Under the old rule she
    // hits her booking target and misses her delivered one — which is how a team
    // looks on-plan all month and lands short.
    const high = base({ rollingRto: 0.30 });
    expect(Number(high.requiredBookingCorrected)).toBeGreaterThan(Number(high.requiredBookingLegacy));
    expect(targetMovementPercent(high)!).toBeGreaterThan(20);
  });

  it('agrees with the flat rule at the RTO the flat rule implicitly assumed', () => {
    // 1.15 is 1/(1-x) at x = 13.04%. So the old rule was correct for exactly one
    // rep — whichever one happened to sit there — and wrong for everyone else.
    const at = base({ rollingRto: 1 - 1 / Number(LEGACY_FLAT_UPLIFT) });
    expect(Number(at.requiredBookingCorrected)).toBeCloseTo(Number(at.requiredBookingLegacy), 1);
  });
});

describe('the runaway case', () => {
  it('caps an extreme RTO instead of demanding an impossible number', () => {
    // 1/(1-0.95) is 20x. That is not a target, it is a message that something is
    // badly wrong, and printing it as a target buries the message.
    const extreme = base({ rollingRto: 0.95 });
    expect(extreme.rtoCapped).toBe(true);
    const capped = base({ rollingRto: RTO_CAP_FOR_TARGETS });
    expect(extreme.requiredBookingCorrected).toBe(capped.requiredBookingCorrected);
  });

  it('SAYS it capped, rather than quietly applying it', () => {
    expect(base({ rollingRto: 0.95 }).notes.join(' ')).toMatch(/cap/i);
    expect(base({ rollingRto: 0.95 }).notes.join(' ')).toMatch(/delivery conversation/i);
  });

  it('does not cap a merely bad rate', () => {
    expect(base({ rollingRto: 0.35 }).rtoCapped).toBe(false);
  });
});

describe('edges that would otherwise divide by zero', () => {
  it('a met target asks for nothing more, and does not go negative', () => {
    const met = base({ realisedValue: '400000.00' });
    expect(Number(met.valueBalance)).toBeLessThan(0);
    expect(met.perDayReqDelivery).toBe('0.00');
    expect(met.notes.join(' ')).toMatch(/already met/i);
  });

  it('no working days left means no per-day figure at all, not infinity', () => {
    const done = base({ remainingWorkingDays: 0 });
    expect(done.perDayReqDelivery).toBeNull();
    expect(done.requiredBookingCorrected).toBeNull();
    expect(done.requiredBookingLegacy).toBeNull();
    expect(done.notes.join(' ')).toMatch(/no working days/i);
  });

  it('a rep with no elapsed days has no run-rate yet', () => {
    expect(base({ elapsedWorkingDays: 0 }).perDayAvgValue).toBeNull();
  });

  it('a zero RTO leaves the delivery requirement untouched', () => {
    const clean = base({ rollingRto: 0 });
    expect(clean.requiredBookingCorrected).toBe(clean.perDayReqDelivery);
  });
});

describe('a rep with no shipped orders', () => {
  it('is NOT treated as having a perfect 0% RTO', () => {
    // The defect this was written for. Zero shipped orders reads as 0% RTO, which
    // is indistinguishable from a flawless record — and the corrected rule then
    // hands her a 13% target CUT for having no evidence at all. Found by reading
    // the comparison rows rather than the totals.
    const newStarter = base({ rollingRto: 0, shippedOrders: 0, teamRollingRto: 0.2 });
    expect(newStarter.rtoFromTeam).toBe(true);
    expect(newStarter.rollingRto).toBe(0.2);
  });

  it('says so, rather than quietly substituting a number', () => {
    const note = base({ rollingRto: 0, shippedOrders: 0, teamRollingRto: 0.2 }).notes.join(' ');
    expect(note).toMatch(/absence of evidence/i);
  });

  it('a rep WITH a record keeps her own rate, even when it is zero', () => {
    // A genuine 0% over forty shipped orders is an achievement, not a gap, and
    // must not be overwritten by a worse team average.
    const spotless = base({ rollingRto: 0, shippedOrders: 40, teamRollingRto: 0.2 });
    expect(spotless.rtoFromTeam).toBe(false);
    expect(spotless.rollingRto).toBe(0);
  });
});
