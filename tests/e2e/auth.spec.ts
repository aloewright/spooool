import { expect, test } from '@playwright/test';

// ALO-173: authenticated-flow smoke. Signup creates a fresh account each
// run with a UUID-suffixed email so reruns against the same environment
// don't clash. Login round-trips through better-auth and reaches a
// signed-in surface.
//
// These tests share the same shared environment; they don't clean up users
// after themselves (deletion lives behind the 30-day grace window from
// ALO-132). The cron sweeps eventually evict them.
//
// Turnstile: staging uses CF test keys (site: 1x00000000000000000000AA,
// secret: 1x0000000000000000000000000000000AA) so the server-side siteverify
// call always passes. We still stub the client script so the widget fires
// onSuccess immediately without waiting for the real challenges.cloudflare.com
// roundtrip, keeping the test deterministic and fast.

const PASSWORD = 'playwright-e2e-password-1';

function uniqueEmail(): string {
  // Crypto.randomUUID is available in Node 18+ and Playwright's runtime.
  const id = crypto.randomUUID().slice(0, 8);
  return `e2e+${id}@spooool-e2e.test`;
}

async function stubTurnstile(page: import('@playwright/test').Page): Promise<void> {
  await page.route('**/turnstile/v0/api.js*', (route) =>
    route.fulfill({
      status: 200,
      contentType: 'application/javascript',
      body: `
        window.turnstile = {
          render: function (container, options) {
            if (options && typeof options.callback === 'function') {
              options.callback('e2e-turnstile-token');
            }
            return 'e2e-turnstile-widget';
          },
          reset: function () {},
          remove: function () {},
          getResponse: function () { return 'e2e-turnstile-token'; },
        };
        if (typeof window.onloadTurnstileCallback === 'function') {
          window.onloadTurnstileCallback();
        }
      `,
    }),
  );
}

test.describe('signup → home', () => {
  test('a new user can sign up and lands signed-in on the home page', async ({ page }) => {
    await stubTurnstile(page);
    const email = uniqueEmail();
    await page.goto('/signup');
    await page.getByLabel(/name/i).fill('E2E User');
    await page.getByLabel(/email/i).fill(email);
    await page.getByLabel(/password/i).fill(PASSWORD);
    await Promise.all([
      page.waitForURL(/\/(onboarding)?$/),
      page
        .getByRole('main')
        .getByRole('button', { name: /create account/i })
        .click(),
    ]);
    // Signed-in surface should expose an upload entry point.
    await expect(page.getByRole('link', { name: /upload/i })).toBeVisible();
  });

  test('signing in with bad credentials surfaces an error and stays on /login', async ({
    page,
  }) => {
    await stubTurnstile(page);
    await page.goto('/login');
    await page.getByLabel(/email/i).fill('does-not-exist@spooool-e2e.test');
    await page.getByLabel(/password/i).fill('wrong-password');
    await page
      .getByRole('main')
      .getByRole('button', { name: /sign in/i })
      .click();
    await expect(page).toHaveURL(/\/login/);
    await expect(
      page.getByRole('alert').or(page.getByText(/invalid|incorrect|wrong/i)),
    ).toBeVisible();
  });
});
