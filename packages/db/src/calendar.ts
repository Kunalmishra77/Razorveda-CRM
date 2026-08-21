/**
 * Working-calendar generation. Pure functions, no I/O, no database.
 *
 * docs/03 section 8 (D-34, resolves O-08): every "per day" metric divides by a
 * count that comes from `working_calendar`. No hand-typed day counts anywhere.
 *
 * Nothing here hardcodes a year or a weekday. O-08 is signed off on the RULE, not
 * on the client's festival list, so holidays arrive as data and never as a code
 * change.
 */

/** 0 = Sunday ... 6 = Saturday, matching JS getUTCDay(). */
export type Weekday = 0 | 1 | 2 | 3 | 4 | 5 | 6;

export const WEEKDAY = {
  SUNDAY: 0, MONDAY: 1, TUESDAY: 2, WEDNESDAY: 3,
  THURSDAY: 4, FRIDAY: 5, SATURDAY: 6,
} as const satisfies Record<string, Weekday>;

export interface CalendarDay {
  /** YYYY-MM-DD */
  readonly calendarDate: string;
  readonly isWorkingDay: boolean;
}

export interface GenerateOptions {
  /**
   * Weekdays that are never working days. For Razorveda this is [SUNDAY],
   * confirmed by reproducing the client's forward denominator exactly (D-34) —
   * not assumed from a default.
   */
  readonly nonWorkingWeekdays: readonly Weekday[];
  /**
   * Festival closures as YYYY-MM-DD. **Seeded EMPTY and marked provisional** until
   * the client confirms (D-34). Admin-toggleable through data, not code.
   */
  readonly holidays?: readonly string[];
}

const pad = (n: number): string => String(n).padStart(2, '0');

/** UTC throughout: local time would shift dates across the IST boundary. */
export function toIsoDate(d: Date): string {
  return `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())}`;
}

export function parseIsoDate(iso: string): Date {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(iso);
  if (!m) throw new Error(`expected YYYY-MM-DD, got "${iso}"`);
  const [, y, mo, d] = m;
  const date = new Date(Date.UTC(Number(y), Number(mo) - 1, Number(d)));
  if (toIsoDate(date) !== iso) throw new Error(`not a real calendar date: "${iso}"`);
  return date;
}

/** Every day of `year`, flagged. Leap years handled by the Date rollover. */
export function generateYear(year: number, opts: GenerateOptions): CalendarDay[] {
  if (!Number.isInteger(year) || year < 1970 || year > 2999) {
    throw new Error(`year out of range: ${year}`);
  }
  const nonWorking = new Set<number>(opts.nonWorkingWeekdays);
  const holidays = new Set<string>(opts.holidays ?? []);

  const out: CalendarDay[] = [];
  const cursor = new Date(Date.UTC(year, 0, 1));
  while (cursor.getUTCFullYear() === year) {
    const iso = toIsoDate(cursor);
    out.push({
      calendarDate: iso,
      isWorkingDay: !nonWorking.has(cursor.getUTCDay()) && !holidays.has(iso),
    });
    cursor.setUTCDate(cursor.getUTCDate() + 1);
  }
  return out;
}

/** Working days in [fromIso, toIso], both ends INCLUSIVE. */
export function countWorkingDays(
  calendar: readonly CalendarDay[],
  fromIso: string,
  toIso: string,
): number {
  parseIsoDate(fromIso);
  parseIsoDate(toIso);
  if (fromIso > toIso) return 0;
  return calendar.filter(
    (d) => d.isWorkingDay && d.calendarDate >= fromIso && d.calendarDate <= toIso,
  ).length;
}

const lastDayOfMonth = (iso: string): string => {
  const d = parseIsoDate(iso);
  return toIsoDate(new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + 1, 0)));
};

const firstDayOfMonth = (iso: string): string => `${iso.slice(0, 7)}-01`;

const nextDay = (iso: string): string => {
  const d = parseIsoDate(iso);
  d.setUTCDate(d.getUTCDate() + 1);
  return toIsoDate(d);
};

/**
 * Denominator for **Per Day Req Delivery**: working days from TOMORROW to month end.
 *
 * Verified against the client's sheet on the 17 Aug 2026 snapshot: 12 days.
 * That match to five decimals is what confirmed Sundays-off from data (D-34).
 */
export function remainingWorkingDays(calendar: readonly CalendarDay[], todayIso: string): number {
  return countWorkingDays(calendar, nextDay(todayIso), lastDayOfMonth(todayIso));
}

/**
 * Denominator for **Per Day Avg Value**: working days from month start to TODAY.
 *
 * On 17 Aug 2026 this is 14. The client's sheet divides by a hand-typed 11,
 * overstating every rep's forecast by roughly a third (finding F17).
 */
export function elapsedWorkingDays(calendar: readonly CalendarDay[], todayIso: string): number {
  return countWorkingDays(calendar, firstDayOfMonth(todayIso), todayIso);
}
