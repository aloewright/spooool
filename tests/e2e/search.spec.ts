import { expect, test, type Route } from '@playwright/test';

// ALO-E7: E2E coverage for the /search critical path.
//
// Search is the primary content-discovery surface for anonymous users — FTS5
// query → result list → /watch. We don't depend on real D1 fixture data;
// the API responses are stubbed via page.route so the spec is isolated from
// the staging database state.
//
// Coverage:
//   1. Page renders the search input and accepts a query.
//   2. Results surface when the API returns matching videos.
//   3. Empty-state message appears when the API returns no results.
//   4. Rate-limit response (429) surfaces a human-readable error.

function jsonRoute(body: unknown, status = 200) {
  return (route: Route) =>
    route.fulfill({
      status,
      contentType: 'application/json',
      body: JSON.stringify(body),
    });
}

const SEARCH_RESULTS = {
  q: 'cats',
  page: 1,
  limit: 20,
  videos: [
    {
      id: 'search-result-1',
      title: 'Cats being cats',
      description: 'A short clip.',
      view_count: 100,
      channel_name: 'E2E Channel',
      channel_username: 'e2e-channel',
      thumbnail_url: null,
      created_at: '2026-01-01T00:00:00Z',
    },
  ],
};

const EMPTY_RESULTS = {
  q: 'zzznomatchzzz',
  page: 1,
  limit: 20,
  videos: [],
};

test.describe('/search page', () => {
  test('renders a search input', async ({ page }) => {
    await page.route('**/api/auth/get-session', jsonRoute(null));
    await page.goto('/search');
    // The search page must render an accessible search input.
    const input = page
      .getByRole('searchbox')
      .or(page.getByPlaceholder(/search/i))
      .or(page.locator('input[type="search"]'))
      .or(page.locator('input[name="q"]'));
    await expect(input.first()).toBeVisible({ timeout: 10_000 });
  });

  test('shows results when the API returns matches', async ({ page }) => {
    await page.route('**/api/auth/get-session', jsonRoute(null));
    await page.route('**/api/videos/search**', jsonRoute(SEARCH_RESULTS));
    await page.goto('/search?q=cats');
    // At least the title of the first result must be visible.
    await expect(page.getByText('Cats being cats', { exact: false })).toBeVisible({
      timeout: 10_000,
    });
  });

  test('shows an empty-state when the API returns no results', async ({ page }) => {
    await page.route('**/api/auth/get-session', jsonRoute(null));
    await page.route('**/api/videos/search**', jsonRoute(EMPTY_RESULTS));
    await page.goto('/search?q=zzznomatchzzz');
    // Any "no results" / "nothing found" copy is acceptable — different builds
    // may phrase it differently, so we match loosely.
    await expect(
      page.getByText(/no results|nothing found|no videos/i).or(
        page.getByRole('status', { name: /no results/i }),
      ),
    ).toBeVisible({ timeout: 10_000 });
  });

  test('shows a human-readable error when the search is rate-limited', async ({ page }) => {
    await page.route('**/api/auth/get-session', jsonRoute(null));
    await page.route('**/api/videos/search**', jsonRoute({ error: 'Search rate limit exceeded.' }, 429));
    await page.goto('/search?q=cats');
    await expect(page.getByText(/rate limit|too many requests|try again/i)).toBeVisible({
      timeout: 10_000,
    });
  });
});
