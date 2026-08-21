/**
 * Forecast input parameters (docs/03 section 10). Constants live here; VALUES live
 * in seeded tables.
 */

/**
 * Below this many leads behind a disposition's measured conversion rate, fall back
 * to `lead_source.expected_conversion_rate` (D-43).
 *
 * Same shrinkage instinct as the EES score's k=30: a rate computed from nine leads
 * is noise wearing a decimal point.
 */
export const FORECAST_MIN_LEADS_FOR_MEASURED_RATE = 30;

export const ForecastWeightSource = {
  /** >= FORECAST_MIN_LEADS_FOR_MEASURED_RATE leads. Measured from the order ledger. */
  MEASURED_DISPOSITION_RATE: 'MEASURED_DISPOSITION_RATE',
  /** Below the threshold. Using the source's configured expected rate. */
  SOURCE_EXPECTED_RATE: 'SOURCE_EXPECTED_RATE',
} as const;

export type ForecastWeightSource =
  (typeof ForecastWeightSource)[keyof typeof ForecastWeightSource];

/**
 * Seeded value for every month until there is enough history to fit one (D-44).
 * The term stays in the formula; the value is neutralised and flagged provisional.
 * No screen may call the forecast "seasonally adjusted" while this holds.
 */
export const SEASONALITY_INDEX_PLACEHOLDER = 1.0;
