import { expect, test, type Page, type Route } from '@playwright/test';

// ALO-282: end-to-end coverage for the /watch flow — the single most
// critical viewer journey. The page is mocked end-to-end (no DB seeding):
//
//   * Worker API responses are stubbed via `page.route` so the spec is
//     independent of D1 / R2 / Stream state.
//   * The Cloudflare Stream SDK is replaced in `addInitScript` with its public
//     iframe API, which emits `loadedmetadata` and exposes a stable playhead.
//     We're testing the React/UI surface, not media decoding or Stream itself.
//
// Coverage: page renders with the right title and channel badge, the share
// button rewrites its label after copy, and the resume banner appears when
// localStorage holds a stored position — `Watch from start` clears it.

const VIDEO_ID = 'e2e-watch-1';
const VIDEO_TITLE = 'E2E watch fixture';
const CHANNEL_USERNAME = 'e2e-channel';
const CHANNEL_NAME = 'E2E Channel';

// localStorage key used by src/frontend/lib/watch-position.ts.
const POSITIONS_KEY = 'spooool:watch:positions:v1';

async function stubStreamPlayer(page: Page): Promise<void> {
  // StreamPlayer wraps @cloudflare/stream-react, whose player is an iframe
  // controlled through window.Stream(iframe), not a native <video>. Model the
  // public API closely enough to drive Watch's adapter and metadata lifecycle.
  await page.addInitScript(() => {
    Object.assign(window, {
      Stream(iframe: HTMLIFrameElement) {
        const listeners = new Map<string, Set<EventListener>>();
        let currentTime = 0;
        let paused = true;
        const api = {
          autoplay: false,
          buffered: {} as TimeRanges,
          controls: true,
          duration: 100,
          ended: false,
          loop: false,
          muted: false,
          playbackRate: 1,
          played: {} as TimeRanges,
          preload: 'metadata' as const,
          src: '',
          videoHeight: 1080,
          videoWidth: 1920,
          volume: 1,
          get currentTime() {
            return currentTime;
          },
          set currentTime(value: number) {
            currentTime = Number.isFinite(value) ? value : 0;
          },
          get paused() {
            return paused;
          },
          async play() {
            paused = false;
          },
          pause() {
            paused = true;
          },
          addEventListener(event: string, handler: EventListener) {
            const handlers = listeners.get(event) ?? new Set<EventListener>();
            handlers.add(handler);
            listeners.set(event, handlers);
          },
          removeEventListener(event: string, handler: EventListener) {
            listeners.get(event)?.delete(handler);
          },
        };
        Object.defineProperty(iframe, '__spoooolE2EStreamApi', { value: api });
        queueMicrotask(() => {
          for (const handler of listeners.get('loadedmetadata') ?? []) {
            handler.call(api, new Event('loadedmetadata'));
          }
        });
        return api;
      },
    });
  });
}

function jsonRoute(body: unknown, status = 200) {
  return (route: Route) =>
    route.fulfill({
      status,
      contentType: 'application/json',
      body: JSON.stringify(body),
    });
}

async function stubWatchApis(page: Page): Promise<void> {
  await page.route(`**/api/auth/get-session`, jsonRoute(null));
  await page.route(`**/api/users/me/history**`, jsonRoute({ items: [] }));
  await page.route(`**/api/videos/${VIDEO_ID}`, jsonRoute({
    id: VIDEO_ID,
    title: VIDEO_TITLE,
    description: 'fixture body',
    view_count: 42,
    channel_name: CHANNEL_NAME,
    channel_username: CHANNEL_USERNAME,
    stream_video_id: 'e2e-stream-uid',
    status: 'ready',
  }));
  await page.route(`**/api/videos/${VIDEO_ID}/related**`, jsonRoute({
    videos: [
      { id: 'next-1', title: 'Next clip', view_count: 7, channel_name: CHANNEL_NAME },
    ],
  }));
  await page.route(`**/api/videos/${VIDEO_ID}/like`, jsonRoute({ likes: 0, liked: false }));
  await page.route(`**/api/videos/${VIDEO_ID}/tags`, jsonRoute({ tags: [] }));
  await page.route(`**/api/videos/${VIDEO_ID}/comments**`, jsonRoute({ comments: [] }));
  await page.route(`**/api/videos/${VIDEO_ID}/heartbeat`, (route) =>
    route.fulfill({ status: 204, body: '' }),
  );
  await page.route(`**/api/channels/${CHANNEL_USERNAME}/subscription`, jsonRoute({
    subscribed: false,
    subscriberCount: 0,
  }));
  await page.route('https://customer-od6lvjm5bwfl1lki.cloudflarestream.com/**', (route) =>
    route.fulfill({ status: 200, contentType: 'text/html', body: '<!doctype html><title>Stream</title>' }),
  );
}

async function seedResumePosition(page: Page, seconds: number): Promise<void> {
  // Merge into any existing positions map rather than clobbering it — the
  // key holds positions for many videos, and a future test that seeds two
  // ids would otherwise lose the first.
  await page.addInitScript(
    ([key, id, p]) => {
      try {
        let existing: Record<string, { p: number; t: number }> = {};
        const raw = window.localStorage.getItem(key);
        if (raw) {
          const parsed: unknown = JSON.parse(raw);
          if (parsed && typeof parsed === 'object') {
            existing = parsed as Record<string, { p: number; t: number }>;
          }
        }
        window.localStorage.setItem(
          key,
          JSON.stringify({ ...existing, [id]: { p, t: Date.now() } }),
        );
      } catch {
        // localStorage may be unavailable in the test browser context; skip.
      }
    },
    [POSITIONS_KEY, VIDEO_ID, seconds] as const,
  );
}

test.describe('/watch happy path', () => {
  test.beforeEach(async ({ page }) => {
    await stubStreamPlayer(page);
    await stubWatchApis(page);
  });

  test('renders the video page with title, controls, and channel badge', async ({ page }) => {
    await page.goto(`/watch/${VIDEO_ID}`);

    await expect(page.getByRole('heading', { level: 1, name: VIDEO_TITLE })).toBeVisible();
    // Stream is an iframe player; controls live in the provider-owned iframe.
    const player = page.locator('iframe[src*="/e2e-stream-uid/iframe"]');
    await expect(player).toBeVisible();
    await expect(player).toHaveAttribute('allow', /autoplay/);
    await expect(player).toHaveAttribute('allowfullscreen', '');
    // Channel name is surfaced as a badge.
    await expect(page.getByText(CHANNEL_NAME, { exact: true })).toBeVisible();
    // Up next list (mocked related endpoint).
    await expect(page.getByRole('heading', { name: /up next/i })).toBeVisible();
    await expect(page.getByText('Next clip')).toBeVisible();
  });

  test('share-at-current-time button updates its label after copy', async ({ page, context }) => {
    await context.grantPermissions(['clipboard-read', 'clipboard-write']);
    await page.goto(`/watch/${VIDEO_ID}`);

    const share = page.getByRole('button', { name: /share at current time/i });
    await expect(share).toBeVisible();
    await share.click();
    await expect(page.getByRole('button', { name: /link copied/i })).toBeVisible();
  });

  test('share button writes ?t= when current time is non-zero', async ({ page, context }) => {
    await context.grantPermissions(['clipboard-read', 'clipboard-write']);
    await page.goto(`/watch/${VIDEO_ID}`);
    // Wait for the iframe and set its mocked public Stream API playhead.
    await page.locator('iframe[src*="/e2e-stream-uid/iframe"]').waitFor();
    await page.evaluate(() => {
      const iframe = document.querySelector('iframe[src*="/e2e-stream-uid/iframe"]') as
        | (HTMLIFrameElement & { __spoooolE2EStreamApi?: { currentTime: number } })
        | null;
      if (iframe?.__spoooolE2EStreamApi) iframe.__spoooolE2EStreamApi.currentTime = 42;
    });
    await page.getByRole('button', { name: /share at current time/i }).click();
    await expect(page.getByRole('button', { name: /link copied/i })).toBeVisible();

    const copied = await page.evaluate(() => navigator.clipboard.readText());
    expect(copied).toContain('/watch/');
    expect(copied).toMatch(/\?t=/);
  });

  test('resume banner appears when localStorage has a stored position; Watch from start clears it', async ({
    page,
  }) => {
    await seedResumePosition(page, 30);
    await page.goto(`/watch/${VIDEO_ID}`);

    const banner = page.getByRole('status').filter({ hasText: /resumed at/i });
    await expect(banner).toBeVisible();
    await page.getByRole('button', { name: /watch from start/i }).click();
    await expect(banner).toBeHidden();

    // ALO-213 regression — the stored position must be cleared, so a reload
    // doesn't re-offer the same banner.
    await page.reload();
    await expect(
      page.getByRole('status').filter({ hasText: /resumed at/i }),
    ).toBeHidden();
  });
});
