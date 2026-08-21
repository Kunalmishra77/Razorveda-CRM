import { describe, it, expect } from 'vitest';
import {
  WEEKDAY,
  countWorkingDays,
  elapsedWorkingDays,
  generateYear,
  remainingWorkingDays,
} from '../src/calendar.js';

/**
 * docs/03 section 8 / D-34 / finding F17.
 *
 * The headline tests here are not synthetic. They reproduce the client's own
 * MIS numbers from the 17 Aug 2026 snapshot. That is what turned "assume Sundays
 * are off" into "Sundays are off, confirmed by the data".
 */

const SUNDAYS_OFF = { nonWorkingWeekdays: [WEEKDAY.SUNDAY] } as const;
const cal2026 = generateYear(2026, SUNDAYS_OFF);

describe('working calendar — reproduces the client sheet (D-34)', () => {
  it('18-31 Aug 2026 with Sundays off is exactly 12 working days', () => {
    // The client's FORWARD denominator. Per Day Req Delivery = Value Balance / 12.
    expect(countWorkingDays(cal2026, '2026-08-18', '2026-08-31')).toBe(12);
  });

  it("reproduces Nikita's Per Day Req Delivery to five decimals", () => {
    const valueBalance = 153_769.39;
    const days = remainingWorkingDays(cal2026, '2026-08-17');
    expect(days).toBe(12);
    expect(Number((valueBalance / days).toFixed(5))).toBe(12_814.11583);
  });

  it('1-17 Aug 2026 with Sundays off is 14 working days, NOT the hand-typed 11 (F17)', () => {
    expect(elapsedWorkingDays(cal2026, '2026-08-17')).toBe(14);
    expect(elapsedWorkingDays(cal2026, '2026-08-17')).not.toBe(11);
  });

  it('quantifies the over-forecast the hand-typed divisor causes (F17)', () => {
    // Every rep's "Approx Guess Rest of Month" is inflated by the wrong divisor.
    const achieveValue = 146_230.61;
    const remaining = remainingWorkingDays(cal2026, '2026-08-17'); // 12

    const clientForecast = (achieveValue / 11) * remaining;
    const calendarForecast = (achieveValue / elapsedWorkingDays(cal2026, '2026-08-17')) * remaining;

    expect(Math.round(clientForecast)).toBe(159_524);

    // ₹1 note, and it is worth pinning rather than smoothing over. The sheet
    // multiplies the DISPLAYED 2dp per-day figure, not the exact quotient:
    //   displayed:  10,445.04       x 12 = 125,340.48  -> 1,25,340
    //   exact:      10,445.0435714  x 12 = 125,340.52  -> 1,25,341
    // Both are "right"; they are different rounding conventions. Our metrics
    // compute on the exact value and round only at render, so the system will
    // read 1,25,341 where a hand-built sheet reads 1,25,340. Expect this class of
    // one-rupee variance in the Phase 2 reconciliation and do not chase it.
    const displayedPerDay = 10_445.04;
    expect(Math.round(displayedPerDay * remaining)).toBe(125_340);
    expect(Math.round(calendarForecast)).toBe(125_341);

    // The finding itself is robust to the convention: a single rep, a single month.
    expect(Math.round(clientForecast - calendarForecast)).toBe(34_184);
    expect(Math.round(clientForecast - displayedPerDay * remaining)).toBe(34_184);
  });

  it('August 2026 has five Sundays, which is why the split is 3 then 2', () => {
    const sundays = cal2026.filter((d) => d.calendarDate.startsWith('2026-08') && !d.isWorkingDay);
    expect(sundays.map((d) => d.calendarDate)).toEqual([
      '2026-08-02', '2026-08-09', '2026-08-16', '2026-08-23', '2026-08-30',
    ]);
  });
});

describe('working calendar — generator', () => {
  it('generates every day of a non-leap year', () => {
    expect(cal2026).toHaveLength(365);
    expect(cal2026[0]?.calendarDate).toBe('2026-01-01');
    expect(cal2026.at(-1)?.calendarDate).toBe('2026-12-31');
  });

  it('handles leap years', () => {
    expect(generateYear(2028, SUNDAYS_OFF)).toHaveLength(366);
    expect(generateYear(2028, SUNDAYS_OFF).some((d) => d.calendarDate === '2028-02-29')).toBe(true);
  });

  it('does not hardcode Sunday — the non-working set is an argument', () => {
    // O-08 is signed off on the rule, not on a fixed weekend shape.
    const sixDay = generateYear(2026, { nonWorkingWeekdays: [WEEKDAY.SUNDAY] });
    const fiveDay = generateYear(2026, {
      nonWorkingWeekdays: [WEEKDAY.SATURDAY, WEEKDAY.SUNDAY],
    });
    const alwaysOpen = generateYear(2026, { nonWorkingWeekdays: [] });

    expect(sixDay.filter((d) => d.isWorkingDay)).toHaveLength(313);
    expect(fiveDay.filter((d) => d.isWorkingDay)).toHaveLength(261);
    expect(alwaysOpen.filter((d) => d.isWorkingDay)).toHaveLength(365);
  });

  it('does not hardcode the year', () => {
    expect(generateYear(2027, SUNDAYS_OFF)[0]?.calendarDate).toBe('2027-01-01');
    expect(generateYear(2030, SUNDAYS_OFF).at(-1)?.calendarDate).toBe('2030-12-31');
  });

  it('applies holidays as data, and seeds none by default', () => {
    // Festival closures are provisional until the client confirms (D-34), so the
    // seeded set is EMPTY. Adding one must never require a code change.
    expect(cal2026.find((d) => d.calendarDate === '2026-10-20')?.isWorkingDay).toBe(true);

    const withDiwali = generateYear(2026, {
      nonWorkingWeekdays: [WEEKDAY.SUNDAY],
      holidays: ['2026-10-20'],
    });
    expect(withDiwali.find((d) => d.calendarDate === '2026-10-20')?.isWorkingDay).toBe(false);
    // A holiday falling on an already non-working day must not double-count.
    expect(countWorkingDays(withDiwali, '2026-10-01', '2026-10-31')).toBe(
      countWorkingDays(cal2026, '2026-10-01', '2026-10-31') - 1,
    );
  });

  it('is timezone-safe — dates do not shift under IST', () => {
    // Constructing with local time would move 2026-01-01 to 2025-12-31 in some zones.
    expect(cal2026.filter((d) => d.calendarDate.startsWith('2025'))).toHaveLength(0);
    expect(cal2026.filter((d) => d.calendarDate.startsWith('2027'))).toHaveLength(0);
  });

  it('rejects an impossible date rather than silently rolling it over', () => {
    expect(() => countWorkingDays(cal2026, '2026-02-30', '2026-03-01')).toThrow(/not a real/);
    expect(() => countWorkingDays(cal2026, '17-08-2026', '2026-08-31')).toThrow(/YYYY-MM-DD/);
  });

  it('returns 0 for an inverted range instead of a negative count', () => {
    expect(countWorkingDays(cal2026, '2026-08-31', '2026-08-18')).toBe(0);
  });

  it('counts month-end and month-start boundaries inclusively', () => {
    // On the last day of the month there is no tomorrow left in it.
    expect(remainingWorkingDays(cal2026, '2026-08-31')).toBe(0);
    // 1 Aug 2026 is a SATURDAY, and Saturday is a working day here — only Sunday
    // is off. So by Monday 3 Aug two working days have elapsed, not one.
    expect(elapsedWorkingDays(cal2026, '2026-08-03')).toBe(2);
    expect(elapsedWorkingDays(cal2026, '2026-08-01')).toBe(1); // the Saturday alone
    expect(elapsedWorkingDays(cal2026, '2026-08-02')).toBe(1); // Sunday adds nothing
  });
});
