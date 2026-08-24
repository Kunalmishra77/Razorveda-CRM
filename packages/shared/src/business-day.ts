/**
 * WHAT "TODAY" MEANS IN THIS BUSINESS.
 *
 * Razorveda runs on one clock: Asia/Kolkata. Reps work an IST shift, the month
 * closes on an IST calendar, and every `CURRENT_DATE` in Postgres already answers
 * in IST because the server sets `TZ=Asia/Kolkata`.
 *
 * The API did not. Seven places computed today as
 * `new Date().toISOString().slice(0, 10)`, which is the date in UTC — five and a
 * half hours behind. Between midnight and 05:30 IST those two answers are
 * DIFFERENT DAYS, and the code that has to agree with the database is exactly the
 * code that spans that window:
 *
 *   - the repeat-lead job, materialising customers due "today"
 *   - the EES scoring run, keyed on a score_date
 *   - the ingestion controller stamping a batch's day
 *
 * The failure is silent and it looks like a fact about the business. Asking for
 * customers due on or before yesterday returns the ones that were already dealt
 * with yesterday, so the job reports `leadsCreated: 0` and `ok: true`, and an
 * admin reads "nobody is due today". This is the same shape as the RLS bugs this
 * project keeps finding: an empty result presented as an answer.
 *
 * Found when the clock rolled past midnight IST mid-session and four tests
 * started failing that had passed all evening.
 *
 * `en-CA` is not a preference about Canada — it is the locale whose short date
 * format is ISO `YYYY-MM-DD`, which is what Postgres wants and what sorts.
 */

export const BUSINESS_TIMEZONE = 'Asia/Kolkata';

const ISO_DATE = new Intl.DateTimeFormat('en-CA', {
  timeZone: BUSINESS_TIMEZONE,
  year: 'numeric',
  month: '2-digit',
  day: '2-digit',
});

/**
 * Today's date in the business timezone, as `YYYY-MM-DD`.
 *
 * Pass `now` to test a specific instant; the default is the current time.
 */
export function businessToday(now: Date = new Date()): string {
  return ISO_DATE.format(now);
}

/** The same conversion for an arbitrary instant — a stored timestamp, say. */
export function toBusinessDate(instant: Date): string {
  return ISO_DATE.format(instant);
}
