import { subMoney, scaleMoney, money } from '@razorveda/shared';

/**
 * Target arithmetic (docs/03 §2 and §8, Phase 4 deliverable 5).
 *
 * Pure. No database, no clock — the working-day counts and the rolling RTO are
 * passed in, because both are calendar and ledger facts and neither should be
 * re-derived here where a second definition could grow.
 *
 * THE CORRECTION (F11): Required Booking Value
 *
 *   now:  Per Day Req Delivery ÷ (1 − rep_rolling_90d_RTO)
 *   was:  Per Day Req Delivery × 1.15, flat, for everyone
 *
 * The flat uplift assumes every rep loses the same 13% of what they book. They do
 * not. A rep at 5% RTO is asked to book more than she needs; a rep at 30% is asked
 * for far too little and misses her delivered target while hitting her booking
 * one — which is precisely how a team can look on-plan all month and land short.
 *
 * BOTH ARE COMPUTED, SIDE BY SIDE. The corrected figure is not switched on here:
 * it changes what seven people are measured against, so the comparison is a report
 * to be read before anything moves. Reproduce their number first, then show the
 * corrected one beside it.
 */

/** What the sheet does today: one uplift for everybody (F11). */
export const LEGACY_FLAT_UPLIFT = '1.15';

/**
 * Above this, `1 − RTO` gets small enough that the required booking explodes.
 * A rep at 95% RTO would be asked for twenty times her delivery target, which is
 * not a target but a message that something is badly wrong. Capped, and the cap
 * is REPORTED rather than silently applied.
 */
export const RTO_CAP_FOR_TARGETS = 0.6;

export interface TargetInput {
  readonly monthlyTarget: string;
  readonly realisedValue: string;
  /** From working_calendar — never hand-typed (F17, D-34). */
  readonly remainingWorkingDays: number;
  readonly elapsedWorkingDays: number;
  /** Rolling 90-day RTO for this rep, 0–1. */
  readonly rollingRto: number;
  /**
   * Orders this rep actually shipped in the rolling window.
   *
   * Without it, a rep who shipped NOTHING reads 0% RTO — indistinguishable from a
   * rep with a flawless record — and the corrected rule hands her a 13% target
   * CUT for having no evidence at all. Found by running the comparison and reading
   * the rows rather than the totals.
   */
  readonly shippedOrders: number;
  /** The team's rolling RTO, used when a rep has no record of her own. */
  readonly teamRollingRto: number;
}

export interface TargetBreakdown {
  readonly monthlyTarget: string;
  readonly realisedValue: string;
  readonly valueBalance: string;
  readonly perDayReqDelivery: string | null;
  readonly perDayAvgValue: string | null;
  /** The corrected figure — RTO-adjusted per rep. */
  readonly requiredBookingCorrected: string | null;
  /** What the sheet produces today, for comparison only. */
  readonly requiredBookingLegacy: string | null;
  readonly rollingRto: number;
  /** True when the rep's RTO exceeded the cap and the cap was used instead. */
  readonly rtoCapped: boolean;
  /** True when the rep had no shipped orders and the team rate was used. */
  readonly rtoFromTeam: boolean;
  readonly notes: readonly string[];
}

export function computeTargets(input: TargetInput): TargetBreakdown {
  const notes: string[] = [];

  // Value Balance = Target − Realised. docs/03 marks this one "unchanged — current
  // formula is correct", so it is reproduced exactly rather than improved.
  const valueBalance = subMoney(money(input.monthlyTarget), money(input.realisedValue));

  // A target already met has no per-day requirement. Zero, not a negative: telling
  // a rep she must deliver minus four thousand a day is noise.
  const balanceRemaining = Number(valueBalance) > 0 ? valueBalance : '0.00';
  if (Number(valueBalance) <= 0 && Number(input.monthlyTarget) > 0) {
    notes.push('Target already met for this period.');
  }

  const perDayReqDelivery =
    input.remainingWorkingDays > 0
      ? scaleMoney(balanceRemaining, [String(1 / input.remainingWorkingDays)])
      : null;
  if (input.remainingWorkingDays <= 0) {
    notes.push('No working days remain in this period, so there is no per-day requirement.');
  }

  // Run-rate to date. The client's sheet divides by a hand-typed number that no
  // calendar rule produces (D-34); this uses working_calendar, so it is
  // reproducible in December for August.
  const perDayAvgValue =
    input.elapsedWorkingDays > 0
      ? scaleMoney(money(input.realisedValue), [String(1 / input.elapsedWorkingDays)])
      : null;

  // A rep with nothing shipped has an UNKNOWN rate, not a zero one. Using the
  // team's rate is the fail-safe: it neither rewards her for an absence of
  // returns she never had the chance to incur, nor punishes her for the team's.
  const rtoFromTeam = input.shippedOrders === 0;
  const observedRto = rtoFromTeam ? input.teamRollingRto : input.rollingRto;
  if (rtoFromTeam) {
    notes.push(
      'No orders shipped in the rolling window, so this rep has no RTO record of her own. ' +
        `The team rate (${(input.teamRollingRto * 100).toFixed(1)}%) was used. A 0% reading here ` +
        'would be an absence of evidence, not a perfect one.',
    );
  }

  const rtoCapped = observedRto > RTO_CAP_FOR_TARGETS;
  const effectiveRto = rtoCapped ? RTO_CAP_FOR_TARGETS : Math.max(observedRto, 0);
  if (rtoCapped) {
    notes.push(
      `Rolling RTO is ${(input.rollingRto * 100).toFixed(1)}%, above the ${(RTO_CAP_FOR_TARGETS * 100).toFixed(0)}% cap. ` +
        `The cap was used for the target. A rep at this rate needs a delivery conversation, not a bigger number.`,
    );
  }

  const requiredBookingCorrected =
    perDayReqDelivery === null
      ? null
      : scaleMoney(perDayReqDelivery, [String(1 / (1 - effectiveRto))]);

  const requiredBookingLegacy =
    perDayReqDelivery === null ? null : scaleMoney(perDayReqDelivery, [LEGACY_FLAT_UPLIFT]);

  return {
    monthlyTarget: money(input.monthlyTarget),
    realisedValue: money(input.realisedValue),
    valueBalance,
    perDayReqDelivery,
    perDayAvgValue,
    requiredBookingCorrected,
    requiredBookingLegacy,
    rollingRto: observedRto,
    rtoCapped,
    rtoFromTeam,
    notes,
  };
}

/**
 * How far the correction moves this rep, as a signed percentage of the legacy
 * figure. The number the client will actually react to.
 */
export function targetMovementPercent(breakdown: TargetBreakdown): number | null {
  const { requiredBookingCorrected: corrected, requiredBookingLegacy: legacy } = breakdown;
  if (corrected === null || legacy === null || Number(legacy) === 0) return null;
  return ((Number(corrected) - Number(legacy)) / Number(legacy)) * 100;
}
