import { expect, test, type Page, type Route } from '@playwright/test';

// ALO-282: end-to-end coverage for the /watch flow — the single most
// critical viewer journey. The page is mocked end-to-end (no DB seeding):
//
//   * Worker API responses are stubbed via `page.route` so the spec is
//     independent of D1 / R2 / Stream state.
//   * The `<video>` element is patched in `addInitScript` so video.js sees
//     `loadedmetadata` + a non-zero duration without us shipping a real MP4
//     fixture. We're testing the React/UI surface, not media decoding.
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

async function stubVideoElement(page: Page): Promise<void> {
  // The video.js adapter waits for `loadedmetadata` on the underlying media
  // element before deciding whether to seek to a stored / ?t= position. We
  // don't ship a real fixture in the repo, so we patch the prototype to make
  // every <video> behave as if a 100s clip just finished loading.
  await page.addInitScript(() => {
    const proto = HTMLVideoElement.prototype;
    let storedTime = 0;
    Object.defineProperty(proto, 'duration', {
      configurable: true,
      get: () => 100,
    });
    Object.defineProperty(proto, 'readyState', {
      configurable: true,
      get: () => 4,
    });
    Object.defineProperty(proto, 'currentTime', {
      configurable: true,
      get: () => storedTime,
      set(v: number) {
        storedTime = Number.isFinite(v) ? Number(v) : 0;
      },
    });
    Object.defineProperty(proto, 'paused', {
      configurable: true,
      get: () => true,
    });
    // Mark playback as no-op so videojs's call into `play()` doesn't reject.
    HTMLMediaElement.prototype.play = function play(): Promise<void> {
      return Promise.resolve();
    };
    HTMLMediaElement.prototype.pause = function pause(): void {
      // no-op
    };
    HTMLMediaElement.prototype.load = function load(): void {
      // Synthesize the load events videojs listens for.
      queueMicrotask(() => {
        this.dispatchEvent(new Event('loadedmetadata'));
        this.dispatchEvent(new Event('loadeddata'));
        this.dispatchEvent(new Event('canplay'));
      });
    };
    // Setting `.src` should also nudge videojs forward.
    const origSrcDescriptor = Object.getOwnPropertyDescriptor(
      HTMLMediaElement.prototype,
      'src',
    );
    Object.defineProperty(proto, 'src', {
      configurable: true,
      get(): string {
        return this.getAttribute('src') ?? '';
      },
      set(v: string) {
        if (origSrcDescriptor && typeof origSrcDescriptor.set === 'function') {
          origSrcDescriptor.set.call(this, v);
        } else {
          this.setAttribute('src', v ?? '');
        }
        queueMicrotask(() => {
          this.dispatchEvent(new Event('loadedmetadata'));
          this.dispatchEvent(new Event('loadeddata'));
          this.dispatchEvent(new Event('canplay'));
        });
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
    r2_key: `${VIDEO_ID}.mp4`,
    status: 'uploaded',
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
  // Stream URL is requested by the <video>; harmless 200 keeps the network log clean.
  await page.route(`**/api/videos/${VIDEO_ID}/stream**`, (route) =>
    route.fulfill({ status: 200, contentType: 'video/mp4', body: '' }),
  );
}

async function seedResumePosition(page: Page, seconds: number): Promise<void> {
  await page.addInitScript(
    ([key, id, p]) => {
      try {
        window.localStorage.setItem(key, JSON.stringify({ [id]: { p, t: Date.now() } }));
      } catch {
        // localStorage may be unavailable in the test browser context; skip.
      }
    },
    [POSITIONS_KEY, VIDEO_ID, seconds] as const,
  );
}

test.describe('/watch happy path', () => {
  test.beforeEach(async ({ page }) => {
    await stubVideoElement(page);
    await stubWatchApis(page);
  });

  test('renders the video page with title, controls, and channel badge', async ({ page }) => {
    await page.goto(`/watch/${VIDEO_ID}`);

    await expect(page.getByRole('heading', { level: 1, name: VIDEO_TITLE })).toBeVisible();
    // <video> with controls is the player surface — the engine wraps this.
    const video = page.locator('video');
    await expect(video).toBeVisible();
    await expect(video).toHaveJSProperty('controls', true);
    // Channel name is surfaced as a badge.
    await expect(page.getByText(CHANNEL_NAME, { exact: false })).toBeVisible();
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
    // Wait for the video to mount, then nudge currentTime forward via the
    // stub so the share URL gets a `?t=` suffix.
    await page.locator('video').waitFor();
    await page.evaluate(() => {
      const video = document.querySelector('video');
      if (video) video.currentTime = 42;
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
