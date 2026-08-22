import { defineConfig } from 'vitest/config';

/**
 * Database-backed isolation suite. Requires DATABASE_URL. Never skips.
 *
 * SEQUENTIAL, DELIBERATELY.
 *
 * These files share one database and one set of seeded reps, and several of them
 * mutate global state: the velocity-lock test locks an account, offboarding exits
 * an employee, the recall test unassigns leads. Run in parallel, the velocity
 * lock would fire while the adversarial suite was signing in as the same rep —
 * which is exactly what happened, and which presented as a security test failing
 * intermittently. A flaky security test is worse than a slow one: it gets re-run
 * until it passes.
 *
 * Fixing it by giving every file its own rep was the alternative. Sequential is
 * simpler, and these suites take seconds.
 */
export default defineConfig({
  test: {
    include: ['test/rls/**/*.test.ts'],
    testTimeout: 30_000,
    hookTimeout: 30_000,
    fileParallelism: false,
  },
});
