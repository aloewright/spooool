import { expect, test, type Route } from '@playwright/test';

// E2E coverage for the /upload critical path (ALO-E7).
//
// We can't drive a real upload end-to-end in CI — that would require a
// fixture video file, a real Stream/R2 write, and non-trivial teardown. What
// we test here:
//
//   1. Auth gate: unauthenticated users are redirected to /login.
//   2. Form surface: authenticated users see the file picker and metadata
//      fields; the upload area is reachable and labelled.
//   3. Rate-limit response: the page surfaces a human-readable error when
//      the upload endpoint (/api/videos/upload) returns 429.
//
// All backend calls are stubbed via page.route so the spec is isolated
// from D1 / R2 / Stream state.

function jsonRoute(body: unknown, status = 200) {
  return (route: Route) =>
    route.fulfill({
      status,
      contentType: 'application/json',
      body: JSON.stringify(body),
    });
}

const AUTHED_SESSION = {
  user: {
    id: 'e2e-uploader-1',
    name: 'E2E Uploader',
    email: 'uploader@spooool-e2e.test',
    emailVerified: true,
  },
  session: { id: 'e2e-session-1' },
};

async function stubAuthedSession(page: import('@playwright/test').Page): Promise<void> {
  await page.route('**/api/auth/get-session', jsonRoute(AUTHED_SESSION));
}

// The staging bundle bakes in VITE_TURNSTILE_SITE_KEY (hydrated from Doppler at
// build time), so the Upload form renders a real Cloudflare Turnstile widget
// and the submit guard blocks until a captcha token is set. Replace the
// Turnstile API script with a shim whose render() immediately fires the success
// callback, so onSubmit can reach the real /api/videos/upload request
// deterministically — without depending on a live challenge.
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

async function stubUploadApis(page: import('@playwright/test').Page): Promise<void> {
  await stubAuthedSession(page);
  await stubTurnstile(page);
  // The chunked uploader (src/frontend/lib/chunked-upload.ts) POSTs every chunk
  // to /api/videos/upload as multipart/form-data. A successful single-chunk
  // upload returns 201 with `{ id }` — the uploader reads `body.id` as the
  // videoId. Mock a success so the form can submit without touching D1/R2/Stream.
  await page.route(
    '**/api/videos/upload',
    jsonRoute({ id: 'e2e-video-123', status: 'queued' }, 201),
  );
}

test.describe('/upload auth gate', () => {
  test('unauthenticated users are redirected to /login', async ({ page }) => {
    // Explicitly return no session — the default stub.
    await page.route('**/api/auth/get-session', jsonRoute(null));
    await page.goto('/upload');
    // The redirect / prompt resolves after the session fetch settles, so poll
    // rather than reading the URL synchronously right after goto. The page may
    // either redirect to /login or render an inline "sign in" prompt.
    await expect(async () => {
      const isLoginPage = page.url().includes('/login');
      const hasSignInPrompt = await page
        .getByRole('link', { name: /sign in/i })
        .or(page.getByText(/sign in to upload/i))
        .isVisible()
        .catch(() => false);
      expect(isLoginPage || hasSignInPrompt).toBe(true);
    }).toPass();
  });
});

test.describe('/upload form surface', () => {
  test.beforeEach(async ({ page }) => {
    await stubUploadApis(page);
  });

  test('renders a file picker and metadata fields', async ({ page }) => {
    await page.goto('/upload');

    // A file input or drop-zone must be visible.
    const fileInput = page.locator('input[type="file"]');
    const dropZone = page
      .getByRole('button', { name: /choose file|browse|select file|drop/i })
      .or(page.getByText(/drag.*(video|file)|drop.*(video|file)/i));
    await expect(fileInput.or(dropZone)).toBeVisible({ timeout: 10_000 });

    // Metadata fields: title is required.
    await expect(
      page.getByLabel(/title/i).or(page.getByPlaceholder(/title/i)),
    ).toBeVisible();
  });

  test('upload page title includes the product name', async ({ page }) => {
    await page.goto('/upload');
    await expect(page).toHaveTitle(/spooool/i);
  });
});

test.describe('/upload rate-limit response', () => {
  test('shows a human-readable error when the upload is rate-limited', async ({ page }) => {
    await stubAuthedSession(page);
    await stubTurnstile(page);

    // The real upload posts every chunk to /api/videos/upload (see
    // src/frontend/lib/chunked-upload.ts). The server rate-limits the init
    // chunk and returns 429 with this exact body (src/workers/videos.ts).
    const RATE_LIMIT_MESSAGE = 'Upload rate limit exceeded. Try again shortly.';
    await page.route(
      '**/api/videos/upload',
      jsonRoute({ error: RATE_LIMIT_MESSAGE }, 429),
    );

    await page.goto('/upload');

    // Fill the required fields: a title and a video file. The Upload button is
    // disabled until a valid file is selected, so set the file first.
    await page
      .locator('input[type="file"]')
      .setInputFiles({
        name: 'test.mp4',
        mimeType: 'video/mp4',
        buffer: Buffer.from('fake-video-content'),
      });
    await page.getByLabel(/title/i).fill('E2E rate-limit upload');

    // Submit the real upload and confirm the request actually fired, so the
    // assertion below can never pass without the upload being attempted.
    const uploadRequest = page.waitForRequest('**/api/videos/upload');
    await page.getByRole('button', { name: /^upload$/i }).click();
    await uploadRequest;

    // On a 429 the chunk uploader throws and the page surfaces the message via
    // setError(). The visible text embeds the server's human-readable string.
    // Always assert it — no conditional guard.
    await expect(page.getByText(/upload rate limit exceeded/i)).toBeVisible();
  });
});
