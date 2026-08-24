import { defineConfig, devices } from '@playwright/test';

/**
 * CRITICAL E2E FLOWS ONLY (CLAUDE.md section 3).
 *
 * WHY THESE EXIST AT ALL, given 703 other tests.
 *
 * `apps/web` had zero behavioural coverage. Twelve routes, typechecked and (now)
 * built, with nothing exercising them. Everything proven so far is proven at the
 * API or the database: RLS isolation, the money rules, the metric definitions. All
 * of that can be perfectly correct while the login form posts to the wrong path,
 * the session cookie is dropped, the CSRF header is missing, or the worklist
 * renders an error because a field was renamed.
 *
 * Those are precisely the failures a rep meets on her first morning and no
 * existing test can see.
 *
 * DELIBERATELY FEW. This is not a second test suite for the business rules - the
 * rules are tested where they live, against a database, in milliseconds. A browser
 * test that re-asserts an incentive figure would be slow, flaky, and a second
 * source of truth for something already settled. These cover the seams BETWEEN the
 * browser and the API, and stop there.
 *
 * BROWSER CHOICE. Chromium is downloaded in CI. Locally, PLAYWRIGHT_CHANNEL=chrome
 * uses the Chrome already on the machine, because a 130 MB download to run two
 * tests is how a suite stops being run.
 */

const channel = process.env['PLAYWRIGHT_CHANNEL'];

export default defineConfig({
  testDir: './e2e',
  // These drive one shared API and one seeded database. Parallel runs would have
  // two tests signing in as the same rep, and the copy-velocity lock would start
  // firing mid-suite - the same lesson the RLS suite already learned.
  fullyParallel: false,
  workers: 1,
  forbidOnly: !!process.env['CI'],
  // Retries hide flakiness, and flakiness in an auth test is a real finding. If
  // one of these is unreliable, that is the bug.
  retries: 0,
  reporter: process.env['CI'] ? [['github'], ['list']] : [['list']],
  timeout: 30_000,
  expect: { timeout: 10_000 },

  use: {
    baseURL: process.env['WEB_URL'] ?? 'http://localhost:3000',
    trace: 'retain-on-failure',
    screenshot: 'only-on-failure',
    video: 'off',
  },

  projects: [
    {
      name: 'chromium',
      use: { ...devices['Desktop Chrome'], ...(channel ? { channel } : {}) },
    },
  ],
});
