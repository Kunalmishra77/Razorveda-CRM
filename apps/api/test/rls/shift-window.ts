import type pg from 'pg';

/**
 * PUT THE SEEDED ROSTER INSIDE ITS SHIFT FOR THE LENGTH OF A TEST RUN.
 *
 * Sign-in is refused outside a rep's shift, and the seeded reps work 10:00–20:00.
 * Every test that authenticates over HTTP therefore passed or failed on the WALL
 * CLOCK: green all afternoon, and `OUTSIDE_SHIFT_HOURS` for anyone running the
 * suite in the evening or on a CI box in a timezone where 14:00 UTC is not 14:00
 * in Kolkata. A suite that is green only during office hours is not a suite.
 *
 * The rule is not weakened and the check is not stubbed — the accounts are simply
 * on shift while the tests run, which is the state the tests mean to describe.
 * `restoreShifts` puts the seeded hours back, so a human poking at the app
 * afterwards still meets the real behaviour.
 *
 * Scoped to `emp_code LIKE 'EMP-%'` for the same reason every other fixture is
 * (D-306): accounts created by other tests must not be caught by it.
 */

export async function openShifts(pool: pg.Pool): Promise<void> {
  await pool.query(
    `UPDATE employee SET shift_start = '00:00', shift_end = '23:59'
      WHERE emp_code LIKE 'EMP-%'`,
  );
}

export async function restoreShifts(pool: pg.Pool | undefined): Promise<void> {
  await pool
    ?.query(
      `UPDATE employee SET shift_start = '10:00', shift_end = '20:00'
        WHERE emp_code LIKE 'EMP-%'`,
    )
    .catch(() => undefined);
}
