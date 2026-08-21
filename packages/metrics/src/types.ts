/**
 * The metric registry mirrors docs/03-metric-dictionary.md one-to-one.
 *
 * docs/03 rule 1: "If a metric is not in this file, it does not exist and no
 * screen may display it."
 * docs/03 rule 3: "packages/metrics has a test that fails if this file and the
 * registry drift apart."
 *
 * That test is test/registry-parity.test.ts. It is the thing that keeps the
 * dictionary honest for two years, so do not weaken it to make a change pass.
 */

/** Sections 1-4 are metrics. Section 5 lists the EES score components. */
export type MetricKind = 'metric' | 'score_component';

/**
 * `legacy` means: the definition is recorded so Phase 2 can reproduce the client's
 * number in the variance report, and the render layer must refuse to display it
 * anywhere else (N8, D-38).
 *
 * Recorded, not omitted. An "it is documented but not a metric" category outside
 * the dictionary is how the dictionary starts rotting — one source of truth, with
 * a status on it.
 *
 * Absent means `live`. test/legacy-containment.test.ts enforces the restriction in
 * code rather than in a comment.
 */
export type MetricStatus = 'live' | 'legacy';

export interface MetricDef {
  /** Stable snake_case id used in code, API responses and view columns. */
  readonly key: string;
  /**
   * Display name. MUST match the first column of the docs/03 table character
   * for character, ignoring bold markers and any parenthetical gloss.
   */
  readonly name: string;
  /** docs/03 section number this metric is defined in. */
  readonly section: 1 | 2 | 3 | 4 | 5;
  readonly kind: MetricKind;
  /** Omitted means 'live'. See MetricStatus. */
  readonly status?: MetricStatus;
  /** Grain the metric is computed at, e.g. "rep x day". */
  readonly grain: string;
  /** The formula exactly as the dictionary states it. Prose, not executable. */
  readonly formula: string;
  /**
   * Reps dial from their own handsets (D-03), so dials, connects and
   * connectivity are claimed numbers, not measured ones. Any screen showing a
   * self-reported metric must label it as such (docs/04).
   */
  readonly selfReported?: boolean;
  /** Audit finding this metric exists to fix, e.g. "F9". */
  readonly fixes?: string;
  /** Weight in the EES score. Section 5 only. */
  readonly weight?: number;
  /**
   * Certified view SQL. Reports read these; they never compute their own
   * arithmetic (docs/04). Filled in as the views land in Phase 4.
   */
  readonly sql?: string;
}

export type MetricKey = MetricDef['key'];
