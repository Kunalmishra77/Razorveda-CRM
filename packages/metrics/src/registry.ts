import type { MetricDef } from './types.js';

/**
 * THE registry. Mirrors docs/03-metric-dictionary.md exactly.
 *
 * Adding a metric here without adding it to docs/03 fails the parity test, and
 * so does the reverse. Changing a definition is a change request with an
 * effective date, not a code edit (docs/03 rule 4).
 */
export const METRICS: readonly MetricDef[] = [
  // ── 1. Activity metrics ──────────────────────────────────────────────────
  {
    key: 'total_dialling',
    name: 'Total Dialling',
    section: 1,
    kind: 'metric',
    grain: 'rep x day',
    formula: "COUNT(activity WHERE type='CALL')",
    selfReported: true,
  },
  {
    key: 'num_of_connect',
    name: 'Num of Connect',
    section: 1,
    kind: 'metric',
    grain: 'rep x day',
    formula: "COUNT(activity WHERE type='CALL' AND connected=true)",
    selfReported: true,
  },
  {
    key: 'connectivity_pct',
    name: 'Connectivity %',
    section: 1,
    kind: 'metric',
    grain: 'rep x day x source',
    formula: 'Num of Connect / Total Dialling',
    selfReported: true,
  },
  {
    key: 'cd',
    name: 'CD',
    section: 1,
    kind: 'metric',
    grain: 'rep x period',
    formula: 'COUNT(DISTINCT lead_id WHERE ever_connected)',
  },
  {
    key: 'nd',
    name: 'ND',
    section: 1,
    kind: 'metric',
    grain: 'rep x period',
    formula: 'Assigned Leads - CD',
  },
  {
    key: 'todays_cd',
    name: "Today's CD",
    section: 1,
    kind: 'metric',
    grain: 'rep x day',
    // Uses first_connected_at, added for this metric. first_contact_at is NOT a
    // substitute: contact is not connect (defect B5).
    formula: 'COUNT(DISTINCT lead WHERE lead.first_connected_at::date = CURRENT_DATE)',
  },
  {
    key: 'fq',
    name: 'Fq',
    section: 1,
    kind: 'metric',
    grain: 'lead',
    formula: 'COUNT(activity) GROUP BY lead_id',
  },
  {
    key: 'buyers_fq',
    name: 'Buyers Fq',
    section: 1,
    kind: 'metric',
    grain: 'customer',
    formula: "COUNT(order WHERE status='DELIVERED') GROUP BY customer_id",
  },
  {
    key: 'followup_sla_pct',
    name: 'Follow-up SLA %',
    section: 1,
    kind: 'metric',
    grain: 'rep x day',
    formula: 'followups_actioned_on_time / followups_due',
  },
  {
    key: 'untouched_leads',
    name: 'Untouched Leads',
    section: 1,
    kind: 'metric',
    grain: 'rep',
    // Column is contact_attempts, not activity_count (defect B5).
    formula: "COUNT(lead WHERE contact_attempts = 0 AND assigned_at < now() - interval '48 hours')",
  },

  // ── 2. Data block metrics ────────────────────────────────────────────────
  {
    key: 'no_of_data',
    name: 'No of Data',
    section: 2,
    kind: 'metric',
    grain: 'batch',
    formula: 'COUNT(lead) WHERE ingestion_batch_id = X',
  },
  {
    key: 'given_date',
    name: 'Given Date',
    section: 2,
    kind: 'metric',
    grain: 'batch',
    formula: 'MIN(lead_assignment.assigned_at) for the batch',
  },
  {
    key: 'data_valid_till',
    name: 'Data Valid Till',
    section: 2,
    kind: 'metric',
    grain: 'batch',
    formula: 'assigned_at + lead_source.validity_days',
  },
  {
    key: 'order_target',
    name: 'Order Target',
    section: 2,
    kind: 'metric',
    grain: 'batch',
    // Fractional by design. A target is an expectation, not a count. Do not round
    // it, and do not confuse it with Total Orders, which is always an integer.
    formula: 'No of Data x lead_source.expected_conversion_rate',
  },
  {
    key: 'till_achieve_order',
    name: 'Till Achieve Order',
    section: 2,
    kind: 'metric',
    grain: 'batch',
    formula: "COUNT(order WHERE lead.batch_id = X AND status='DELIVERED')",
  },
  {
    key: 'conversion_pct',
    name: 'Conversion %',
    section: 2,
    kind: 'metric',
    grain: 'batch',
    formula: 'Till Achieve Order / No of Data',
  },
  {
    key: 'data_ageing',
    name: 'Data Ageing',
    section: 2,
    kind: 'metric',
    grain: 'batch',
    formula: 'CURRENT_DATE - assigned_at in days',
  },

  // ── 3. Revenue metrics ───────────────────────────────────────────────────
  {
    key: 'booked_value',
    name: 'Booked Value',
    section: 3,
    kind: 'metric',
    grain: 'rep x period',
    formula: 'SUM(order.final_value) WHERE order_date IN period. Status-independent. Provisional.',
    fixes: 'F10',
  },
  {
    key: 'realised_value',
    name: 'Realised Value',
    section: 3,
    kind: 'metric',
    grain: 'rep x period',
    // Cash basis, keyed on delivered_date (D-13). The only number that pays incentive.
    formula:
      "SUM(order.final_value) WHERE current_status='DELIVERED' AND delivered_date IN period",
  },
  {
    key: 'total_orders',
    name: 'Total Orders',
    section: 3,
    kind: 'metric',
    grain: 'rep x period',
    formula: 'COUNT(DISTINCT order_id). Integer, always.',
    fixes: 'F9',
  },
  {
    key: 'product_line_revenue',
    name: 'Product Line Revenue',
    section: 3,
    kind: 'metric',
    grain: 'product line x period',
    formula:
      'SUM(order_line.line_value) GROUP BY sku.line_id, restricted to delivered orders',
    fixes: 'F8',
  },
  {
    key: 'aov',
    name: 'AOV',
    section: 3,
    kind: 'metric',
    grain: 'rep x period',
    formula: 'Realised Value / Delivered Orders',
  },
  {
    key: 'rto_pct',
    name: 'RTO %',
    section: 3,
    kind: 'metric',
    grain: 'rep x period',
    formula:
      'RTO Value / (Delivered Value + RTO Value) for orders dispatched in the period',
    fixes: 'F12',
  },
  {
    key: 'prepaid_ratio',
    name: 'Prepaid Ratio',
    section: 3,
    kind: 'metric',
    grain: 'order',
    formula: 'prepaid_amount / final_value',
    fixes: 'F5',
  },
  {
    key: 'value_balance',
    name: 'Value Balance',
    section: 3,
    kind: 'metric',
    grain: 'rep x period',
    formula: 'Target - Realised Value',
  },
  {
    key: 'per_day_req_delivery',
    name: 'Per Day Req Delivery',
    section: 3,
    kind: 'metric',
    grain: 'rep x period',
    formula: 'Value Balance / remaining_working_days from working_calendar',
  },
  {
    key: 'required_booking_value',
    name: 'Required Booking Value',
    section: 3,
    kind: 'metric',
    grain: 'rep x period',
    // Replaces the flat x1.15, which understated Kajal by 47%.
    formula: 'Per Day Req Delivery / (1 - rep_rolling_90d_RTO)',
    fixes: 'F11',
  },
  {
    key: 'per_day_avg_value',
    name: 'Per Day Avg Value',
    section: 3,
    kind: 'metric',
    grain: 'rep x period',
    // The metric was never the defect - the hand-typed divisor was. Fixing the
    // denominator fixes the metric, so this is live and displayable (N8).
    formula: 'Realised Value / elapsed_working_days from working_calendar',
    fixes: 'F17',
  },
  {
    key: 'forecast',
    name: 'Forecast',
    section: 3,
    kind: 'metric',
    grain: 'rep x period',
    // Stage probabilities come from a SEEDED TABLE, never constants: Phase 3 fits
    // them from history and that must not be a code change.
    formula:
      '((open_pipeline x stage_probability) + (Per Day Avg Value x remaining_working_days)) x (1 - rep_rolling_90d_RTO)',
    fixes: 'F16',
  },
  {
    key: 'approx_guess_rest_of_month',
    name: 'Approx Guess Rest of Month',
    section: 3,
    kind: 'metric',
    status: 'legacy',
    grain: 'rep x period',
    // Straight-line: no pipeline weighting, no RTO adjustment. Exists ONLY so the
    // Phase 2 variance report can reproduce the client's figure. Superseded by
    // Forecast. Referencing this key outside the reconciliation module is a test
    // failure, not a review comment.
    formula: 'Per Day Avg Value x remaining_working_days',
    fixes: 'F16',
  },

  // ── 4. Attribution metrics ───────────────────────────────────────────────
  {
    key: 'company_base_value',
    name: 'Company Base Value',
    section: 4,
    kind: 'metric',
    grain: 'order',
    formula:
      'Order value committed before rep intervention. From sku.shopify_base_price for Shopify, from the imported campaign order value for WA_CAMPAIGN, else 0.',
    fixes: 'F7',
  },
  {
    key: 'employee_credited_value',
    name: 'Employee Credited Value',
    section: 4,
    kind: 'metric',
    grain: 'order x rep',
    formula: 'order.final_value - company_base_value, per the source rule',
  },
  {
    key: 'upsell_index',
    name: 'Upsell Index',
    section: 4,
    kind: 'metric',
    grain: 'rep x period',
    formula: 'Employee Credited Value / Company Base Value on upsell-eligible orders',
  },
  {
    key: 'realised_credited_value',
    name: 'Realised Credited Value',
    section: 4,
    kind: 'metric',
    grain: 'rep x period',
    formula: "Employee Credited Value where current_status='DELIVERED'. Incentive basis.",
  },
  {
    key: 'clawback',
    name: 'Clawback',
    section: 4,
    kind: 'metric',
    grain: 'order x rep',
    formula: 'Credited value reversed when a delivered order flips to RTO/RETURNED',
  },

  // ── 5. Performance score (EES) components ────────────────────────────────
  // Percentile-ranked within the active team, then weighted. Bayesian shrinkage
  // k=30. Source-mix neutralised. Reports on reps; does NOT assign leads.
  {
    key: 'score_conversion_rate',
    name: 'Conversion Rate',
    section: 5,
    kind: 'score_component',
    grain: 'rep x period',
    formula: 'Delivered orders / leads assigned',
    weight: 0.25,
  },
  {
    key: 'score_value_per_lead',
    name: 'Value per Lead',
    section: 5,
    kind: 'score_component',
    grain: 'rep x period',
    formula: 'Realised value / leads assigned',
    weight: 0.25,
  },
  {
    key: 'score_delivery_quality',
    name: 'Delivery Quality',
    section: 5,
    kind: 'score_component',
    grain: 'rep x period',
    formula: '1 - RTO%',
    weight: 0.2,
  },
  {
    key: 'score_upsell_index',
    name: 'Upsell Index',
    section: 5,
    kind: 'score_component',
    grain: 'rep x period',
    formula: 'Credited / base on eligible orders',
    weight: 0.15,
  },
  {
    key: 'score_activity_discipline',
    name: 'Activity Discipline',
    section: 5,
    kind: 'score_component',
    grain: 'rep x period',
    formula: 'Follow-up SLA + dial coverage + untouched rate',
    weight: 0.1,
  },
  {
    key: 'score_data_hygiene',
    name: 'Data Hygiene',
    section: 5,
    kind: 'score_component',
    grain: 'rep x period',
    formula: 'Dispositions filled, remarks present, no stale leads',
    weight: 0.05,
  },
] as const;

/** Lookup by stable key. Reports and API responses address metrics by key. */
export const METRICS_BY_KEY: ReadonlyMap<string, MetricDef> = new Map(
  METRICS.map((m) => [m.key, m]),
);

/** Metrics only (sections 1-4). Excludes EES score components. */
export const metricsOnly = (): readonly MetricDef[] => METRICS.filter((m) => m.kind === 'metric');

/** EES score components (section 5). */
export const scoreComponents = (): readonly MetricDef[] =>
  METRICS.filter((m) => m.kind === 'score_component');

/** Absent status means live. */
export const statusOf = (m: MetricDef): 'live' | 'legacy' => m.status ?? 'live';

/** The only metrics a screen may display. */
export const liveMetrics = (): readonly MetricDef[] =>
  METRICS.filter((m) => statusOf(m) === 'live');

/**
 * Recorded for reconciliation only. The render layer must refuse these, and
 * test/legacy-containment.test.ts fails if a key here is referenced outside the
 * reconciliation module (N8, D-38).
 */
export const legacyMetrics = (): readonly MetricDef[] =>
  METRICS.filter((m) => statusOf(m) === 'legacy');

/** Any screen showing one of these must label it as self-reported (D-03, docs/04). */
export const selfReportedKeys = (): readonly string[] =>
  METRICS.filter((m) => m.selfReported).map((m) => m.key);
