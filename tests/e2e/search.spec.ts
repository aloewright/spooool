import { expect, test, type Route } from '@playwright/test';

// E2E coverage for the /search critical path (ALO-E7).
//
// Search is rate-limited (60 req/min via RateLimiterDO) and backed by FTS5
// on D1. We don't seed real data — all backend calls are stubbed via
// page.route so the spec is independent of D1 state.
//
// Coverage:
//   1. No query: /search renders the "Type a query" prompt.
//   2. With query: /search?q=hello returns and renders stubbed results.
//   3. Empty results: API returns [] and the page surfaces the empty-state copy.
//   4. Rate limit: 429 from /api/videos/search surfaces a visible error.

function jsonRoute(body: unknown, status = 200) {
  return (route: Route) =>
    route.fulfill({
      status,
      contentType: 'application/json',
      body: JSON.stringify(body),
    });
}

const STUB_VIDEO = {
  id: 'e2e-search-1',
  title: 'E2E Search Fixture',
  description: 'A stubbed video for search E2E tests.',
  channel_name: 'E2E Channel',
  channel_username: 'e2e-channel',
  thumbnail_url: null,
  view_count: 42,
  created_at: '2026-01-01T00:00:00Z',
};

test.describe('/search — no query', () => {
  test('shows "Type a query" prompt when no ?q= is provided', async ({ page }) => {
    await page.goto('/search');
    await expect(page.getByRole('heading', { name: /type a query/i })).toBeVisible();
  });
});

test.describe('/search — with results', () => {
  test('renders heading and result cards for a matching query', async ({ page }) => {
    await page.route(
      '**/api/videos/search**',
      jsonRoute({ videos: [STUB_VIDEO] }),
    );

    await page.goto('/search?q=hello');

    await expect(page.getByRole('heading', { name: /results for "hello"/i })).toBeVisible();
    await expect(page.getByText(STUB_VIDEO.title)).toBeVisible();
    await expect(page.getByText(/42 views/)).toBeVisible();
  });

  test('result cards link to /watch/:id', async ({ page }) => {
    await page.route(
      '**/api/videos/search**',
      jsonRoute({ videos: [STUB_VIDEO] }),
    );

    await page.goto('/search?q=hello');
    await expect(page.getByText(STUB_VIDEO.title)).toBeVisible();

    const link = page.getByRole('link', { name: STUB_VIDEO.title });
    await expect(link).toHaveAttribute('href', `/watch/${STUB_VIDEO.id}`);
  });
});

test.describe('/search — empty results', () => {
  test('shows no-match copy when the API returns an empty list', async ({ page }) => {
    await page.route(
      '**/api/videos/search**',
      jsonRoute({ videos: [] }),
    );

    await page.goto('/search?q=noresults');

    await expect(
      page.getByText(/no videos matched/i),
    ).toBeVisible();
  });
});

test.describe('/search — rate limit', () => {
  test('surfaces an error indicator when the search API returns 429', async ({ page }) => {
    await page.route(
      '**/api/videos/search**',
      jsonRoute({ error: 'Rate limit exceeded' }, 429),
    );

    await page.goto('/search?q=ratelimited');

    // Search.tsx throws on non-ok responses and renders the error via
    // <p className="status-error">. Any visible error text is sufficient —
    // the exact wording is an implementation detail.
    await expect(
      page.locator('.status-error').or(page.getByRole('alert')).or(
        page.getByText(/search failed|error|rate limit/i),
      ),
    ).toBeVisible();
  });
});
