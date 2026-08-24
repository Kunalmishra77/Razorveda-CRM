import { test, expect } from '@playwright/test';

/**
 * THE SEAMS BETWEEN THE BROWSER AND THE API.
 *
 * 703 tests prove the rules. None of them proves a rep can sign in.
 *
 * Every one of the failures below would leave the API perfectly correct and the
 * product unusable: the form posting to the wrong path, the session cookie not
 * being set or not being sent back, the CSRF header missing, the redirect going
 * somewhere a rep has no rights to, the worklist rendering an error because a
 * field was renamed on the server. RLS cannot catch any of them, and neither can
 * a Supertest call that never involves a cookie jar or a real navigation.
 *
 * These are the tests for the first five minutes of a rep's morning.
 *
 * A REP, NOT AN ADMIN, and that is deliberate: admins need TOTP (CLAUDE.md
 * section 3), so an admin flow would need a TOTP generator in the test and would
 * be testing the authenticator rather than the seam. The rep path is the one
 * seven people use every day.
 */

const REP = { email: 'nikita@razorveda.local', password: 'razorveda-dev-only' };

/**
 * Alerts that actually SAY something.
 *
 * Next.js App Router injects its own `role="alert"` route announcer into every
 * page for screen readers. It is always present and always empty, so a bare
 * `[role="alert"]` selector matches it and every assertion about error messages
 * becomes an assertion about a framework element.
 *
 * It cost four failing tests to notice, and the first read looked like the
 * worklist rendering an error. Filtering on non-whitespace text is what makes the
 * selector mean "the app told the user something".
 */
const realAlerts = (page: import('@playwright/test').Page) =>
  page.locator('[role="alert"]').filter({ hasText: /\S/ });

test.describe('a rep signing in', () => {
  test('lands on her dashboard, and can reach her worklist from it', async ({ page }) => {
    await page.goto('/login');

    // Fail loudly if the form is not the form. Without this, a renamed input makes
    // fill() throw a timeout that reads like the app being slow.
    await expect(page.locator('#email'), 'the login form has no #email field').toBeVisible();

    await page.fill('#email', REP.email);
    await page.fill('#password', REP.password);
    await page.click('button[type="submit"]');

    // The redirect is role-dependent: EMPLOYEE -> /dashboard, everyone else
    // -> /today. A rep landing on an admin screen would meet a 401 section and
    // read it as being locked out, so the destination is part of the behaviour.
    await expect(page).toHaveURL(/\/dashboard/, { timeout: 15_000 });

    // And it actually rendered, rather than reaching the route and erroring. An
    // error state on this page is the difference between "she can work" and "she
    // cannot", and it would still be a 200.
    await expect(realAlerts(page), 'the dashboard rendered an error for a rep who just signed in').toHaveCount(0);
    await expect(page.getByRole('heading', { level: 1 })).toBeVisible();

    // The worklist is one click away rather than the landing page, and it still
    // has to render. It is where she spends the day; an error here is the
    // difference between "she can work" and "she cannot", and it would still be
    // a 200.
    await page.goto('/worklist');
    await expect(realAlerts(page), 'the worklist rendered an error for a rep who just signed in').toHaveCount(0);
    await expect(page.getByRole('heading', { level: 1 })).toBeVisible();
  });

  test('a wrong password says what happened, and does not sign her in', async ({ page }) => {
    // CLAUDE.md definition of done, item 5: error states say what happened and
    // what to do next. This is the error state every user hits eventually.
    await page.goto('/login');
    await page.fill('#email', REP.email);
    await page.fill('#password', 'definitely-not-the-password');
    await page.click('button[type="submit"]');

    const alert = realAlerts(page);
    await expect(alert).toBeVisible({ timeout: 15_000 });

    // Not "Something went wrong". The message has to be about the credentials.
    await expect(alert).not.toHaveText(/something went wrong/i);
    await expect(alert).not.toHaveText(/^\s*$/);

    // Still on the login page, and no session was created. The second assertion is
    // the one that matters: an error message shown while the cookie was set anyway
    // would be a real authentication bypass.
    await expect(page).toHaveURL(/\/login/);
    await page.goto('/worklist');
    await expect(page, 'an unauthenticated visit to /worklist was not sent back to login').toHaveURL(/\/login/);
  });

  test('the session survives a full page reload', async ({ page }) => {
    // The cookie has to be persistent and correctly scoped. A session held only in
    // memory works perfectly in every click-through test and drops the rep at the
    // login screen the first time she refreshes - or when the browser restores her
    // tabs in the morning.
    await page.goto('/login');
    await page.fill('#email', REP.email);
    await page.fill('#password', REP.password);
    await page.click('button[type="submit"]');
    await expect(page).toHaveURL(/\/dashboard/, { timeout: 15_000 });

    await page.reload();
    await expect(page, 'the session did not survive a reload').toHaveURL(/\/dashboard/);
    await expect(page.getByRole('heading', { level: 1 })).toBeVisible();
  });
});

test.describe('what a rep must not reach', () => {
  test('an admin-only screen does not render admin data for her', async ({ page }) => {
    // RLS answers "whose rows"; it cannot answer "may she open this screen". The
    // API guards the endpoints, so what is being checked here is that the UI does
    // not present an admin surface as though it worked - a rep who sees the
    // Security Console and gets empty tables has been told she is allowed in.
    await page.goto('/login');
    await page.fill('#email', REP.email);
    await page.fill('#password', REP.password);
    await page.click('button[type="submit"]');
    await expect(page).toHaveURL(/\/dashboard/, { timeout: 15_000 });

    await page.goto('/security');

    // THE PROPERTY, not a phrase. The first version of this grepped the page for
    // words like "forbidden" and failed against a perfectly good message that
    // happened not to use them - testing the copywriting instead of the boundary.
    //
    // What must be true is structural: no admin surface is rendered. The rail is
    // the surface - it names all seven admin screens and what each one does, which
    // is the part she should not be shown.
    await expect(
      page.getByRole('navigation', { name: 'Admin sections' }),
      'The admin rail rendered for a rep. Even with every API call refused, this ' +
        'advertises the whole admin surface and leaves her looking at empty tables ' +
        'with no explanation.',
    ).toHaveCount(0);

    // And she is told what happened, with somewhere to go. A blank page would also
    // pass the assertion above and would be worse than the bug.
    await expect(page.getByRole('heading', { level: 1 })).toBeVisible();
    await expect(page.getByRole('link', { name: /worklist/i })).toBeVisible();
  });
});
