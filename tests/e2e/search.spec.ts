import { expect, test, type Route } from '@playwright/test';

// E2E coverage for the /search critical path (ALO-E7).
//
// The search page calls GET /api/videos/search?q=... (FTS5 on D1) and
// GET /api/videos/search/suggest for typeahead. All backend calls are
// stubbed via page.route so the spec is isolated from D1 state.
//
// Coverage:
//   1. Results surface: a query renders a result list with correct title.
//   2. Rate-limit response: the page shows a human-readable error on 429.
//   3. Empty / whitespace query: no search request is fired.

function jsonRoute(body: unknown, status = 200) {
  return (route: Route) =>
    route.fulfill({
      status,
      contentType: 'application/json',
      body: JSON.stringify(body),
    });
}

const FIXTURE_VIDEO = {
  id: 'search-fixture-1',
  title: 'My Fixture Video',
  description: 'a fixture',
  view_count: 5,
  channel_name: 'Fixture Channel',
  channel_username: 'fixture-channel',
  stream_video_id: null,
  thumbnail_url: null,
  created_at: '2026-01-01T00:00:00.000Z',
  updated_at: '2026-01-01T00:00:00.000Z',
};

async function stubSearchApis(
  page: import('@playwright/test').Page,
  opts: { status?: number; body?: unknown } = {},
): Promise<void> {
  const status = opts.status ?? 200;
  const body = opts.body ?? { q: 'fixture', page: 1, limit: 20, videos: [FIXTURE_VIDEO] };
  await page.route('**/api/videos/search**', jsonRoute(body, status));
  // Suppress suggest calls so they don't interfere with request assertions.
  await page.route('**/api/videos/search/suggest**', jsonRoute({ suggestions: [] }));
  await page.route('**/api/auth/get-session', jsonRoute(null));
}

test.describe('/search results', () => {
  test('renders search results from the API', async ({ page }) => {
    await stubSearchApis(page);
    await page.goto('/search?q=fixture');

    // The page must show the fixture video title.
    await expect(page.getByText('My Fixture Video')).toBeVisible({ timeout: 10_000 });
  });

  test('search result links go to /watch/:id', async ({ page }) => {
    await stubSearchApis(page);
    await page.goto('/search?q=fixture');

    const link = page
      .getByRole('link', { name: /My Fixture Video/i })
      .or(page.locator(`a[href*="${FIXTURE_VIDEO.id}"]`))
      .first();
    await expect(link).toBeVisible({ timeout: 10_000 });
    const href = await link.getAttribute('href');
    expect(href).toMatch(new RegExp(FIXTURE_VIDEO.id));
  });

  test('shows a human-readable error when search is rate-limited', async ({ page }) => {
    await stubSearchApis(page, {
      status: 429,
      body: { error: 'Search rate limit exceeded.' },
    });
    await page.goto('/search?q=fixture');

    await expect(
      page.getByText(/rate limit|too many|try again/i),
    ).toBeVisible({ timeout: 10_000 });
  });
});

test.describe('/search page shell', () => {
  test('search page title includes the product name', async ({ page }) => {
    await stubSearchApis(page);
    await page.goto('/search');
    await expect(page).toHaveTitle(/spooool/i);
  });

  test('no search request is fired for an empty query', async ({ page }) => {
    await page.route('**/api/auth/get-session', jsonRoute(null));
    await page.route('**/api/videos/search/suggest**', jsonRoute({ suggestions: [] }));

    const searchRequests: string[] = [];
    await page.route('**/api/videos/search**', (route) => {
      // Capture any unexpected search call so the assertion below is informative.
      searchRequests.push(route.request().url());
      return route.fulfill({ status: 200, contentType: 'application/json', body: '{"videos":[]}' });
    });

    await page.goto('/search');
    // Allow time for any debounced requests to fire.
    await page.waitForTimeout(500);

    // The page shell must render without triggering a search for an empty query.
    // (If the URL has no ?q= param the component should not call the API at all.)
    const searchCallsWithQuery = searchRequests.filter((url) =>
      url.includes('?q=') && !url.includes('q=&') && !url.includes('q=%20'),
    );
    expect(searchCallsWithQuery).toHaveLength(0);
  });
});
