import { describe, it, expect } from 'vitest';
import {
  COMPONENT_KEYS, computeScores, percentileRank, shrink, SHRINKAGE_K, weightOf,
  type CohortStat, type ComponentKey,
} from '../src/scoring/ees.js';

/**
 * EES (docs/03 §5).
 *
 * The tests worth having here are the ones a plausible-but-wrong implementation
 * still passes by eye: that a rep with twelve leads cannot top the table, that a
 * rep handed easy sources gains nothing from it, and that identical work scores
 * identically regardless of array order.
 */

const zero: Record<ComponentKey, number> = {
  score_conversion_rate: 0, score_value_per_lead: 0, score_delivery_quality: 0,
  score_upsell_index: 0, score_activity_discipline: 0, score_data_hygiene: 0,
};

const stat = (
  employeeId: string,
  sourceId: string,
  leadsAssigned: number,
  values: Partial<Record<ComponentKey, number>> = {},
): CohortStat => ({
  employeeId, sourceId, leadsAssigned,
  values: { ...zero, ...values },
  counts: {
    delivered: 0, rto: 0, realisedValue: 0, creditedValue: 0, baseValue: 0,
    touched: 0, dispositioned: 0, withRemarks: 0,
  },
});

describe('the weights come from the metric registry', () => {
  it('every component has one, and they total 100%', () => {
    const total = COMPONENT_KEYS.reduce((sum, k) => sum + weightOf(k), 0);
    // If docs/03 §5 and the registry ever disagree, the parity test fails first.
    // This asserts the set is COMPLETE, which parity alone does not.
    expect(Number(total.toFixed(10))).toBe(1);
  });

  it('matches docs/03 §5 exactly', () => {
    expect(weightOf('score_conversion_rate')).toBe(0.25);
    expect(weightOf('score_value_per_lead')).toBe(0.25);
    expect(weightOf('score_delivery_quality')).toBe(0.2);
    expect(weightOf('score_upsell_index')).toBe(0.15);
    expect(weightOf('score_activity_discipline')).toBe(0.1);
    expect(weightOf('score_data_hygiene')).toBe(0.05);
  });
});

describe('Bayesian shrinkage', () => {
  it('is k = 30 leads, per docs/03 §5', () => {
    expect(SHRINKAGE_K).toBe(30);
  });

  it('pulls a tiny sample almost all the way to the team mean', () => {
    // 3 leads: (3×1.0 + 30×0.5) / 33 = 0.545 — barely above average, not top.
    expect(shrink(1.0, 3, 0.5)).toBeCloseTo(0.5455, 4);
  });

  it('leaves a large sample almost entirely alone', () => {
    // 300 leads: (300×1.0 + 30×0.5) / 330 = 0.9545
    expect(shrink(1.0, 300, 0.5)).toBeCloseTo(0.9545, 4);
  });

  it('returns the prior outright when there is no evidence at all', () => {
    expect(shrink(1.0, 0, 0.42)).toBe(0.42);
  });
});

describe('percentile rank', () => {
  it('shares ties instead of ordering them arbitrarily', () => {
    // Without the half-credit, two identical reps would rank by array position and
    // could swap between runs that found the same numbers.
    expect(percentileRank(5, [5, 5, 5, 5])).toBe(50);
  });

  it('puts a clear best and worst at the ends, without claiming 100 or 0', () => {
    expect(percentileRank(9, [1, 2, 3, 9])).toBe(87.5);
    expect(percentileRank(1, [1, 2, 3, 9])).toBe(12.5);
  });

  it('scores a team of one at 50, not 100', () => {
    // One rep is exactly average by definition. Calling her the best in the
    // company is a claim the data cannot support.
    expect(percentileRank(0.9, [0.9])).toBe(50);
  });
});

describe('the twelve-leads-and-one-lucky-order case, honestly', () => {
  /**
   * docs/03 §5 states the goal — "a rep with 12 leads and one lucky order must
   * not top the table" — and prescribes Bayesian shrinkage with k = 30 to achieve
   * it. Shrinkage is the right tool and k = 30 is implemented as written, but it
   * DOES NOT achieve that goal, and no value of k does.
   *
   * Modelled properly, "one lucky order" means she converted 1 of 12 leads, so her
   * conversion rate is poor. The component that spikes is value per lead: one big
   * order over a tiny denominator.
   *
   *   lucky   12 leads,  ₹4,166/lead      steady  300 leads, ₹1,200/lead
   *   lead-weighted team mean: ₹1,160
   *
   *   k=  30   lucky 2019  steady 1196     lucky still first
   *   k= 300   lucky 1276  steady 1180     lucky still first
   *   k=2000   lucky 1178  steady 1165     lucky still first
   *
   * Why no k works: shrinkage moves every rep toward the same mean, and both of
   * these sit above it. As k grows, lucky's excess tends to 12×(4166−1160)/k and
   * steady's to 300×(1200−1160)/k — 36,072 against 12,000. Lucky's lead is larger
   * at every k. Shrinkage cannot REORDER two reps on the same side of the mean; it
   * can only compress the gap.
   *
   * So these tests assert what k = 30 genuinely does — it halves the outlier —
   * and record that the documented promise needs a second mechanism. Changing k,
   * adding a minimum-lead threshold, or capping outliers are all scoring-definition
   * changes, which is a decision for the client, not a silent fix here.
   */
  const LUCKY = 4166;
  const STEADY = 1200;
  const AVERAGE = 1000;

  const cohorts: CohortStat[] = [
    stat('lucky', 'S1', 12, { score_value_per_lead: LUCKY }),
    stat('steady', 'S1', 300, { score_value_per_lead: STEADY }),
    stat('average', 'S1', 300, { score_value_per_lead: AVERAGE }),
  ];

  it('moves her a long way toward the mean — roughly halving the outlier', () => {
    const scores = computeScores(cohorts);
    const lucky = scores.find((s) => s.employeeId === 'lucky')!;
    // 4166 raw -> ~2019 after shrinkage. Real work, and worth having.
    expect(lucky.neutralised.score_value_per_lead).toBeCloseTo(2019, 0);
    expect(lucky.neutralised.score_value_per_lead).toBeLessThan(LUCKY / 2 + 100);
  });

  it('does NOT demote her below the steady rep — the documented goal is unmet', () => {
    // Asserted so the gap is visible in a failing-test-shaped way if anyone later
    // "fixes" the score and assumes this case is covered.
    const scores = computeScores(cohorts);
    const lucky = scores.find((s) => s.employeeId === 'lucky')!;
    const steady = scores.find((s) => s.employeeId === 'steady')!;
    expect(lucky.score).toBeGreaterThan(steady.score);
  });

  it('no value of k would demote her, so tuning k is not the fix', () => {
    // The proof, executable. Both reps are above the mean, so lucky's excess
    // stays proportionally larger at every k.
    const mean = (12 * LUCKY + 300 * STEADY + 300 * AVERAGE) / 612;
    for (const k of [30, 100, 300, 1000, 10_000, 1_000_000]) {
      expect(
        shrink(LUCKY, 12, mean, k) > shrink(STEADY, 300, mean, k),
        `k=${k} unexpectedly reordered them`,
      ).toBe(true);
    }
  });

  it('says shrinkage was applied, so a reader knows the numbers moved', () => {
    expect(computeScores(cohorts).every((s) => s.shrinkageApplied)).toBe(true);
  });

  it('DOES protect against the small-sample case on a normal metric', () => {
    // Where shrinkage works as advertised: a tiny sample slightly above the mean
    // is pulled back below a large sample that is genuinely better.
    const scores = computeScores([
      stat('small', 'S1', 5, { score_conversion_rate: 0.62 }),
      stat('big', 'S1', 400, { score_conversion_rate: 0.60 }),
      stat('weak', 'S1', 400, { score_conversion_rate: 0.40 }),
    ]);
    const small = scores.find((s) => s.employeeId === 'small')!;
    const big = scores.find((s) => s.employeeId === 'big')!;
    expect(big.score).toBeGreaterThan(small.score);
  });
});

describe('source-mix neutralisation', () => {
  /**
   * Two reps, identical skill within every source. One is handed the easy source.
   * Without neutralisation the score reports the admin's assignment choices.
   */
  const EASY = 'DELIVERED_REPEAT';
  const HARD = 'META_ADS';

  const cohorts: CohortStat[] = [
    // 'favoured' works only the easy source; 'mixed' splits between both.
    stat('favoured', EASY, 100, { score_conversion_rate: 0.6 }),
    stat('mixed', EASY, 50, { score_conversion_rate: 0.6 }),
    stat('mixed', HARD, 50, { score_conversion_rate: 0.2 }),
    stat('other', HARD, 100, { score_conversion_rate: 0.2 }),
  ];

  it('does not reward being given the easy source, when skill is identical', () => {
    const scores = computeScores(cohorts);
    const favoured = scores.find((s) => s.employeeId === 'favoured')!;
    const mixed = scores.find((s) => s.employeeId === 'mixed')!;
    const other = scores.find((s) => s.employeeId === 'other')!;

    // Every rep performs exactly at her cohort's mean, so after neutralisation all
    // three land on the same figure and tie. Any spread here is the assignment
    // showing through.
    expect(favoured.neutralised.score_conversion_rate).toBeCloseTo(
      mixed.neutralised.score_conversion_rate, 6,
    );
    expect(mixed.neutralised.score_conversion_rate).toBeCloseTo(
      other.neutralised.score_conversion_rate, 6,
    );
  });

  it('still separates reps who genuinely differ WITHIN a source', () => {
    const better = computeScores([
      stat('good', HARD, 200, { score_conversion_rate: 0.4 }),
      stat('poor', HARD, 200, { score_conversion_rate: 0.1 }),
    ]);
    const good = better.find((s) => s.employeeId === 'good')!;
    const poor = better.find((s) => s.employeeId === 'poor')!;
    expect(good.score).toBeGreaterThan(poor.score);
  });
});

describe('the score itself', () => {
  it('is a weighted sum of percentiles, so it stays inside 0–100', () => {
    const scores = computeScores([
      stat('a', 'S1', 100, { score_conversion_rate: 0.9, score_value_per_lead: 900 }),
      stat('b', 'S1', 100, { score_conversion_rate: 0.1, score_value_per_lead: 100 }),
    ]);
    for (const s of scores) {
      expect(s.score).toBeGreaterThanOrEqual(0);
      expect(s.score).toBeLessThanOrEqual(100);
    }
  });

  it('does not depend on the order the cohorts arrive in', () => {
    // Nightly jobs do not guarantee row order, and a rep's score changing because
    // Postgres returned a different plan is indefensible.
    const rows: CohortStat[] = [
      stat('a', 'S1', 80, { score_conversion_rate: 0.7 }),
      stat('b', 'S1', 90, { score_conversion_rate: 0.4 }),
      stat('c', 'S2', 70, { score_conversion_rate: 0.5 }),
    ];
    const forward = computeScores(rows);
    const backward = computeScores([...rows].reverse());
    for (const s of forward) {
      expect(backward.find((x) => x.employeeId === s.employeeId)!.score).toBe(s.score);
    }
  });

  it('gives an identical team identical scores', () => {
    const scores = computeScores([
      stat('a', 'S1', 100, { score_conversion_rate: 0.5 }),
      stat('b', 'S1', 100, { score_conversion_rate: 0.5 }),
      stat('c', 'S1', 100, { score_conversion_rate: 0.5 }),
    ]);
    expect(new Set(scores.map((s) => s.score)).size).toBe(1);
    expect(scores[0]!.score).toBe(50);
  });

  it('returns nothing for an empty team rather than dividing by zero', () => {
    expect(computeScores([])).toEqual([]);
  });
});
