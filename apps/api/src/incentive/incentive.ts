import { addMoney, money, scaleMoney, sumMoney } from '@razorveda/shared';

/**
 * Incentive computation (docs/03 §6, Phase 3 deliverable 3).
 *
 *   Payable = Σ REALISED_CREDIT − Σ CLAWBACK, for period_key
 *
 * then slab, modifiers and bonuses on top. Pure: no database, no clock, no I/O.
 * Every branch is testable without a Postgres, which matters more here than
 * anywhere else in the codebase — this is the number that reaches a payslip.
 *
 * THE VALUES ARE PROVISIONAL AND THE ENGINE SAYS SO (O-09).
 *
 * docs/03 §6 marks its slabs and modifiers as PROPOSALS, not the client's scheme.
 * So `provisional` is carried on the result, propagated from the rows the
 * calculation actually used, and cannot be cleared by this module. A figure that
 * looks authoritative and is not gets paid, and the correction is a conversation
 * about money already promised.
 *
 * ORDER OF OPERATIONS — the part docs/03 does not specify, made explicit here:
 *
 *   base            = realised credited value, net of clawback
 *   percent         = slab% + prepaid bonus% + product SPIF%
 *   payable         = base × percent × delivery-quality multiplier
 *                     + repeat bonus (flat ₹ per qualifying order)
 *
 * The reasoning: the three percentages are all "% of realised credited value", so
 * they combine additively; the delivery-quality lever is called a multiplier and
 * prices in margin destruction across the whole payable, so it multiplies; the
 * repeat bonus is a flat amount per order and cannot be scaled by a percentage
 * without becoming something else. This is a MONEY RULE and needs confirming —
 * it is flagged as such, and every figure is provisional until it is.
 *
 * Rounding happens once, at the end. Intermediate values keep full precision, so
 * a rep is not paid a different number depending on how the terms were grouped.
 */

export interface Slab {
  readonly minValue: string;
  readonly maxValue: string | null;
  readonly percent: string;
  readonly isProvisional: boolean;
}

export interface Modifier {
  readonly kind: 'DELIVERY_QUALITY' | 'PREPAID_BONUS' | 'PRODUCT_SPIF' | 'REPEAT_BONUS';
  readonly thresholdMin: string | null;
  readonly thresholdMax: string | null;
  readonly lineId: string | null;
  readonly value: string;
  readonly isProvisional: boolean;
}

export interface IncentiveInput {
  /** Σ employee_credited_value WHERE is_realised, for the period. Clawbacks are negative. */
  readonly realisedCredited: string;
  /** Delivered orders in the period, for the RTO ratio and the repeat bonus. */
  readonly ordersDelivered: number;
  readonly ordersRto: number;
  /** Σ prepaid_amount ÷ Σ final_value across the period's delivered orders. */
  readonly prepaidRatio: string;
  /** Delivered orders to a customer with Buyer Fq ≥ the repeat threshold. */
  readonly repeatOrders: number;
  /** Product lines sold in the period, for SPIFs. */
  readonly lineIds: readonly string[];
  readonly slabs: readonly Slab[];
  readonly modifiers: readonly Modifier[];
}

export interface IncentiveBreakdown {
  readonly base: string;
  readonly slabPercent: string;
  readonly prepaidBonusPercent: string;
  readonly spifPercent: string;
  readonly effectivePercent: string;
  readonly deliveryQualityMultiplier: string;
  readonly rtoPercent: string;
  readonly repeatBonus: string;
  readonly payable: string;
  /**
   * True when ANY row used was provisional, or when no scheme was configured.
   * Never cleared here — only a non-provisional set of rows produces a final figure.
   */
  readonly provisional: boolean;
  /** Plain-language reasons, for the payslip and for an admin checking a number. */
  readonly notes: readonly string[];
}

export class IncentiveError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'IncentiveError';
  }
}

export function computeIncentive(input: IncentiveInput): IncentiveBreakdown {
  const notes: string[] = [];
  let provisional = false;

  // A negative period is possible and is NOT an error: a month whose clawbacks
  // exceed its realisations is a rep who had a bad run of returns. It pays zero,
  // it does not pay a negative, and it does not carry forward — cash basis
  // (metric dictionary §7) means the reversal already landed in this period.
  const base = money(input.realisedCredited);
  if (Number(base) <= 0) {
    return {
      base,
      slabPercent: '0.00', prepaidBonusPercent: '0.00', spifPercent: '0.00',
      effectivePercent: '0.00', deliveryQualityMultiplier: '1.0000',
      rtoPercent: rtoRatio(input), repeatBonus: '0.00', payable: '0.00',
      provisional: true,
      notes: [
        Number(base) < 0
          ? 'Clawbacks exceeded realised credit this period, so nothing is payable. ' +
            'The shortfall is not carried forward — incentive is cash basis.'
          : 'No realised credit in this period.',
      ],
    };
  }

  // ── the slab ────────────────────────────────────────────────────────────────
  const slab = input.slabs.find(
    (s) =>
      Number(base) >= Number(s.minValue) &&
      (s.maxValue === null || Number(base) < Number(s.maxValue)),
  );
  if (!slab) {
    // Refusing beats guessing. A missing slab means the scheme does not cover this
    // value, and paying 0% silently would look like a calculation rather than a
    // gap in configuration.
    throw new IncentiveError(
      `No incentive slab covers realised credit of ₹${base}. Add a slab that ` +
        `includes this value in Master Data, then recalculate.`,
    );
  }
  provisional ||= slab.isProvisional;
  const slabPercent = money(slab.percent);

  // ── prepaid bonus ───────────────────────────────────────────────────────────
  const prepaid = input.modifiers.find(
    (m) => m.kind === 'PREPAID_BONUS' && Number(input.prepaidRatio) > Number(m.thresholdMin ?? '0'),
  );
  const prepaidBonusPercent = prepaid ? money(prepaid.value) : '0.00';
  if (prepaid) {
    provisional ||= prepaid.isProvisional;
    notes.push(
      `Prepaid ratio ${pct(input.prepaidRatio)} cleared the ${pct(prepaid.thresholdMin ?? '0')} ` +
        `floor, adding ${prepaidBonusPercent}%.`,
    );
  }

  // ── product SPIF ────────────────────────────────────────────────────────────
  // Several lines can be in SPIF at once, so they sum. A rep who sold two
  // promoted lines earned both.
  const spifs = input.modifiers.filter(
    (m) => m.kind === 'PRODUCT_SPIF' && (m.lineId === null || input.lineIds.includes(m.lineId)),
  );
  const spifPercent = spifs.length ? sumMoney(spifs.map((m) => money(m.value))) : '0.00';
  for (const s of spifs) provisional ||= s.isProvisional;
  if (spifs.length) notes.push(`Product SPIF added ${spifPercent}%.`);

  const effectivePercent = addMoney(addMoney(slabPercent, prepaidBonusPercent), spifPercent);

  // ── delivery quality ────────────────────────────────────────────────────────
  const rtoPercent = rtoRatio(input);
  const quality = input.modifiers.find(
    (m) =>
      m.kind === 'DELIVERY_QUALITY' &&
      Number(rtoPercent) >= Number(m.thresholdMin ?? '0') &&
      (m.thresholdMax === null || Number(rtoPercent) < Number(m.thresholdMax)),
  );
  const multiplier = quality ? money(quality.value) : '1.0000';
  if (quality) {
    provisional ||= quality.isProvisional;
    notes.push(
      `RTO ${pct(rtoPercent)} put this period in the ${multiplier}× delivery-quality band.`,
    );
  } else if (input.ordersDelivered + input.ordersRto > 0) {
    // No band matched. Not an error — but silence here would hide a gap in the
    // scheme behind a ×1 that looks deliberate.
    notes.push(
      `No delivery-quality band covers an RTO rate of ${pct(rtoPercent)}, so no ` +
        `multiplier was applied. Check the bands in Master Data.`,
    );
    provisional = true;
  }

  // ── repeat bonus ────────────────────────────────────────────────────────────
  const repeat = input.modifiers.find((m) => m.kind === 'REPEAT_BONUS');
  const repeatBonus = repeat ? scaleMoney(money(repeat.value), [String(input.repeatOrders)]) : '0.00';
  if (repeat && input.repeatOrders > 0) {
    provisional ||= repeat.isProvisional;
    notes.push(`${input.repeatOrders} repeat order(s) added ₹${repeatBonus}.`);
  }

  // ── the payable ─────────────────────────────────────────────────────────────
  // One chain, one rounding. '0.01' turns the percentage into a fraction exactly,
  // so no float ever touches the figure and grouping the terms differently cannot
  // change what a rep is paid.
  const beforeBonus = scaleMoney(base, [effectivePercent, '0.01', multiplier]);
  const payable = addMoney(beforeBonus, repeatBonus);

  return {
    base,
    slabPercent,
    prepaidBonusPercent,
    spifPercent,
    effectivePercent,
    deliveryQualityMultiplier: multiplier,
    rtoPercent,
    repeatBonus,
    payable,
    provisional,
    notes,
  };
}

/**
 * RTO% over orders that actually shipped (docs/03 §3).
 *
 * An order that never left the warehouse belongs in neither the numerator nor the
 * denominator — including it would let a rep improve her delivery quality by
 * booking orders that are cancelled before dispatch.
 */
function rtoRatio(input: Pick<IncentiveInput, 'ordersDelivered' | 'ordersRto'>): string {
  const shipped = input.ordersDelivered + input.ordersRto;
  if (shipped === 0) return '0.0000';
  return (input.ordersRto / shipped).toFixed(4);
}

const pct = (ratio: string): string => `${(Number(ratio) * 100).toFixed(1)}%`;
