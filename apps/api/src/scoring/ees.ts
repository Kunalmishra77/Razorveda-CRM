import { METRICS_BY_KEY } from '@razorveda/metrics';

/**
 * Employee Efficiency Score (docs/03 §5, Phase 3 deliverable 4).
 *
 * "Reports on reps. Does not assign leads." That sentence is in the doc, in the
 * task file, and repeated here, because a score that quietly starts routing work
 * becomes an allocation engine — the exact thing D-02 removed at the client's
 * request.
 *
 * Pure: no database, no clock. The SQL that gathers the raw counts lives in
 * ees.service.ts and contains no arithmetic worth arguing about.
 *
 * THE PIPELINE, in this order, and the order matters:
 *
 *   1. raw component, per rep PER SOURCE COHORT
 *   2. Bayesian shrinkage toward that cohort's team mean, k = 30 leads
 *   3. source-mix neutralisation — re-weight cohorts by the TEAM's mix
 *   4. percentile-rank each component across the active team
 *   5. weight by docs/03 §5 and sum
 *
 * Shrinkage before ranking, not after. "A rep with 12 leads and one lucky order
 * must not top the table" — if you rank first and shrink after, she has already
 * topped it and the shrinkage only moves her score, not her position.
 *
 * Neutralisation before ranking too, for the same reason: without it the score
 * mostly measures the admin's assignment choices. A rep handed DELIVERED_REPEAT
 * leads will out-convert one handed META_ADS however good either of them is, and
 * ranking that is ranking the admin.
 *
 * WEIGHTS COME FROM THE METRIC REGISTRY, not from constants here. docs/03 is the
 * single source of truth for every definition (CLAUDE.md rule 10), the registry
 * mirrors it under a parity test, and a second copy in this file would be a third
 * place for them to disagree.
 */

export const SHRINKAGE_K = 30;

/** The six components, in the order docs/03 §5 lists them. */
export const COMPONENT_KEYS = [
  'score_conversion_rate',
  'score_value_per_lead',
  'score_delivery_quality',
  'score_upsell_index',
  'score_activity_discipline',
  'score_data_hygiene',
] as const;

export type ComponentKey = (typeof COMPONENT_KEYS)[number];

/** One rep's raw numbers within one lead source. */
export interface CohortStat {
  readonly employeeId: string;
  readonly sourceId: string;
  /** Leads assigned in the period. The `n` in the shrinkage formula. */
  readonly leadsAssigned: number;
  readonly values: Readonly<Record<ComponentKey, number>>;
  /**
   * The underlying counts, carried alongside the ratios.
   *
   * Needed because a rep's observed rate is the ratio of her SUMS, not the mean
   * of her per-source ratios — averaging ratios weights a cohort of two leads the
   * same as one of two hundred. The scorer uses `values`; anything reporting what
   * actually happened uses these.
   */
  readonly counts: CohortCounts;
}

export interface CohortCounts {
  readonly delivered: number;
  readonly rto: number;
  readonly realisedValue: number;
  readonly creditedValue: number;
  readonly baseValue: number;
  readonly touched: number;
  readonly dispositioned: number;
  readonly withRemarks: number;
}

/**
 * What a rep actually did, summed across her cohorts.
 *
 * These are the figures that belong in the metric-named columns of
 * `employee_score_daily`. They are NOT shrunk, ranked or source-neutralised —
 * those transformations exist to make reps COMPARABLE, and a column called
 * `rto_pct` must hold this rep's RTO rate, not a team-adjusted artefact of it.
 */
export interface ObservedTotals {
  readonly leadsAssigned: number;
  readonly conversionPct: number;
  readonly rtoPct: number;
  readonly upsellIndex: number;
  readonly followupSlaPct: number;
  readonly dataHygienePct: number;
}

export function observedTotals(cohorts: readonly CohortStat[]): ObservedTotals {
  const sum = (pick: (c: CohortStat) => number): number => cohorts.reduce((a, c) => a + pick(c), 0);

  const leads = sum((c) => c.leadsAssigned);
  const delivered = sum((c) => c.counts.delivered);
  const rto = sum((c) => c.counts.rto);
  const shipped = delivered + rto;
  const base = sum((c) => c.counts.baseValue);

  const ratio = (numerator: number, denominator: number): number =>
    denominator === 0 ? 0 : numerator / denominator;

  return {
    leadsAssigned: leads,
    conversionPct: ratio(delivered, leads),
    rtoPct: ratio(rto, shipped),
    // A zero base is a source with no company-committed value, where the credit IS
    // the whole order — index 1, not a division by zero.
    upsellIndex: base === 0 ? 1 : sum((c) => c.counts.creditedValue) / base,
    followupSlaPct: ratio(sum((c) => c.counts.touched), leads),
    dataHygienePct:
      (ratio(sum((c) => c.counts.dispositioned), leads) +
        ratio(sum((c) => c.counts.withRemarks), leads)) /
      2,
  };
}

export interface RepScore {
  readonly employeeId: string;
  /** After shrinkage and neutralisation, before ranking. */
  readonly neutralised: Readonly<Record<ComponentKey, number>>;
  /** 0–100 within the active team. */
  readonly percentile: Readonly<Record<ComponentKey, number>>;
  /** Weighted sum of the percentiles, 0–100. */
  readonly score: number;
  readonly leadsAssigned: number;
  /** True when any cohort had fewer than k leads and was pulled toward the mean. */
  readonly shrinkageApplied: boolean;
}

export class ScoringError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ScoringError';
  }
}

export function weightOf(key: ComponentKey): number {
  const weight = METRICS_BY_KEY.get(key)?.weight;
  if (weight === undefined) {
    // The registry and this list have drifted. Failing loudly beats scoring
    // people on five components while believing it is six.
    throw new ScoringError(
      `Score component "${key}" has no weight in the metric registry. ` +
        `docs/03 §5 and packages/metrics must define it before it can be scored.`,
    );
  }
  return weight;
}

/**
 * Bayesian shrinkage: `(n × observed + k × prior) ÷ (n + k)`.
 *
 * With k = 30 leads, a rep with 3 leads sits ~91% on the team mean and a rep with
 * 300 sits ~91% on her own performance. That is the intended shape: small samples
 * are evidence of very little, and the score should say so rather than treating a
 * lucky week as excellence.
 */
export function shrink(observed: number, n: number, prior: number, k = SHRINKAGE_K): number {
  if (n <= 0) return prior;
  return (n * observed + k * prior) / (n + k);
}

/**
 * Percentile rank within the team, ties shared.
 *
 * `(below + 0.5 × equal) ÷ total × 100`. The half-credit for ties is what makes
 * it symmetric: without it, identical performance would order arbitrarily by
 * whatever the array happened to hold first, and a rep's position would change
 * between two runs that found the same numbers.
 *
 * A team of one scores 50, not 100. One rep is exactly average by definition, and
 * calling her the best in the company is a claim the data cannot support.
 */
export function percentileRank(value: number, population: readonly number[]): number {
  if (population.length === 0) return 50;
  let below = 0;
  let equal = 0;
  for (const other of population) {
    if (other < value) below += 1;
    else if (other === value) equal += 1;
  }
  return ((below + 0.5 * equal) / population.length) * 100;
}

/**
 * The whole pipeline.
 *
 * `cohorts` is one row per (rep × source) with leads assigned in the period. Reps
 * with no leads at all are excluded by the caller — scoring someone who was on
 * leave at zero and ranking the team against it punishes everyone else.
 */
export function computeScores(cohorts: readonly CohortStat[]): readonly RepScore[] {
  if (cohorts.length === 0) return [];

  const employeeIds = [...new Set(cohorts.map((c) => c.employeeId))];
  const sourceIds = [...new Set(cohorts.map((c) => c.sourceId))];

  // The team's lead mix, which is what every rep is re-weighted onto. Using each
  // rep's OWN mix would leave the assignment advantage exactly where it was.
  const teamLeads = cohorts.reduce((sum, c) => sum + c.leadsAssigned, 0);
  const sourceWeight = new Map<string, number>(
    sourceIds.map((s) => [
      s,
      teamLeads === 0
        ? 0
        : cohorts.filter((c) => c.sourceId === s).reduce((sum, c) => sum + c.leadsAssigned, 0) /
          teamLeads,
    ]),
  );

  // Team mean per (component, source), lead-weighted. An unweighted mean would
  // let a rep with two leads in a cohort move the prior as much as one with two
  // hundred, which defeats the point of having a prior.
  const cohortMean = (key: ComponentKey, sourceId: string): number => {
    const rows = cohorts.filter((c) => c.sourceId === sourceId && c.leadsAssigned > 0);
    const n = rows.reduce((sum, c) => sum + c.leadsAssigned, 0);
    if (n === 0) return 0;
    return rows.reduce((sum, c) => sum + c.values[key] * c.leadsAssigned, 0) / n;
  };

  const means = new Map<string, number>();
  for (const key of COMPONENT_KEYS) {
    for (const sourceId of sourceIds) means.set(`${key}|${sourceId}`, cohortMean(key, sourceId));
  }

  let anyShrunk = false;

  const neutralisedByRep = employeeIds.map((employeeId) => {
    const mine = cohorts.filter((c) => c.employeeId === employeeId);
    const leadsAssigned = mine.reduce((sum, c) => sum + c.leadsAssigned, 0);

    const neutralised = {} as Record<ComponentKey, number>;
    for (const key of COMPONENT_KEYS) {
      let total = 0;
      for (const sourceId of sourceIds) {
        const weight = sourceWeight.get(sourceId) ?? 0;
        if (weight === 0) continue;

        const cohort = mine.find((c) => c.sourceId === sourceId);
        const prior = means.get(`${key}|${sourceId}`) ?? 0;
        const n = cohort?.leadsAssigned ?? 0;
        if (n > 0 && n < SHRINKAGE_K) anyShrunk = true;

        // A rep with no leads in a cohort is scored at the cohort mean, which is
        // what shrinkage with n = 0 gives anyway. She is neither rewarded nor
        // punished for work she was never given.
        total += weight * shrink(cohort?.values[key] ?? prior, n, prior);
      }
      neutralised[key] = total;
    }
    return { employeeId, leadsAssigned, neutralised };
  });

  return neutralisedByRep.map((rep) => {
    const percentile = {} as Record<ComponentKey, number>;
    let score = 0;
    for (const key of COMPONENT_KEYS) {
      const population = neutralisedByRep.map((r) => r.neutralised[key]);
      percentile[key] = percentileRank(rep.neutralised[key], population);
      score += percentile[key] * weightOf(key);
    }
    return {
      employeeId: rep.employeeId,
      neutralised: rep.neutralised,
      percentile,
      score: Number(score.toFixed(2)),
      leadsAssigned: rep.leadsAssigned,
      shrinkageApplied: anyShrunk,
    };
  });
}
