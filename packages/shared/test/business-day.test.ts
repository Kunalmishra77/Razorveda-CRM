import { describe, it, expect } from 'vitest';
import { businessToday, toBusinessDate, BUSINESS_TIMEZONE } from '../src/business-day.js';

/**
 * The window that matters is 18:30–24:00 UTC, which is 00:00–05:30 the NEXT day
 * in Kolkata. Every test below that pins a specific instant is really asking one
 * question: does this agree with what Postgres would say for CURRENT_DATE on a
 * server running TZ=Asia/Kolkata.
 */
describe('what "today" means in this business', () => {
  it('is Kolkata, not UTC — the half-hour offset included', () => {
    expect(BUSINESS_TIMEZONE).toBe('Asia/Kolkata');
  });

  it('has already rolled over at 19:00 UTC, when UTC still says yesterday', () => {
    // 2026-08-24T19:00Z is 2026-08-25 00:30 IST. This is the exact instant that
    // broke four repeat-lead tests: the fixture was due on the Kolkata date and
    // the service asked for the UTC one.
    const instant = new Date('2026-08-24T19:00:00Z');
    expect(instant.toISOString().slice(0, 10)).toBe('2026-08-24');
    expect(businessToday(instant)).toBe('2026-08-25');
  });

  it('has NOT rolled over at 18:00 UTC, half an hour earlier', () => {
    // 23:30 IST on the 24th. The boundary is 18:30 UTC, not 18:00 or 19:00 —
    // India is +05:30, and an offset rounded to whole hours is wrong twice a day.
    expect(businessToday(new Date('2026-08-24T18:00:00Z'))).toBe('2026-08-24');
    expect(businessToday(new Date('2026-08-24T18:29:59Z'))).toBe('2026-08-24');
    expect(businessToday(new Date('2026-08-24T18:30:00Z'))).toBe('2026-08-25');
  });

  it('agrees with UTC during the working day, which is why this hid for so long', () => {
    // 14:00 IST. Every test run in office hours saw the two agree.
    expect(businessToday(new Date('2026-08-24T08:30:00Z'))).toBe('2026-08-24');
  });

  it('formats as YYYY-MM-DD, which is what Postgres takes and what sorts', () => {
    expect(businessToday(new Date('2026-01-05T06:00:00Z'))).toBe('2026-01-05');
    expect(businessToday(new Date('2026-12-31T20:00:00Z'))).toBe('2027-01-01');
  });

  it('crosses a year boundary correctly', () => {
    // 2026-12-31T19:00Z is 2027-01-01 00:30 IST. A month-close job reading the
    // UTC date here would write December's row on New Year's Day.
    expect(toBusinessDate(new Date('2026-12-31T19:00:00Z'))).toBe('2027-01-01');
  });

  it('does not drift for a leap day', () => {
    expect(businessToday(new Date('2028-02-28T19:00:00Z'))).toBe('2028-02-29');
  });
});
