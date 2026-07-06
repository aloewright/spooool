import { expect, test, type Route } from '@playwright/test';

// ALO-E7: E2E coverage for the comments critical path.
//
// Comments are a core social feature on the /watch page. We test:
//   1. Unauthenticated users see existing comments but no post form.
//   2. Authenticated users see the comment input form.
//   3. Submitting a comment makes a POST request to the API; the new
//      comment appears in the list after a successful response.
//
// All API responses are stubbed — no real D1 reads or writes occur.

const VIDEO_ID = 'e2e-comments-video';
const VIDEO_TITLE = 'E2E Comments Fixture';
const CHANNEL_USERNAME = 'e2e-channel';
const CHANNEL_NAME = 'E2E Channel';

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
    id: 'e2e-commenter-1',
    name: 'E2E Commenter',
    email: 'commenter@spooool-e2e.test',
    emailVerified: true,
  },
  session: { id: 'e2e-session-1' },
};

const EXISTING_COMMENT = {
  id: 'comment-1',
  video_id: VIDEO_ID,
  user_id: 'other-user',
  parent_comment_id: null,
  body: 'Great video!',
  created_at: '2026-01-01T00:00:00Z',
  updated_at: '2026-01-01T00:00:00Z',
  deleted_at: null,
  author_name: 'Other User',
  author_username: 'otheruser',
  reply_count: 0,
};

async function stubWatchApis(
  page: import('@playwright/test').Page,
  session: unknown = null,
): Promise<void> {
  await page.route('**/api/auth/get-session', jsonRoute(session));
  await page.route(`**/api/users/me/history**`, jsonRoute({ items: [] }));
  await page.route(`**/api/videos/${VIDEO_ID}`, jsonRoute({
    id: VIDEO_ID,
    title: VIDEO_TITLE,
    description: 'fixture',
    view_count: 5,
    channel_name: CHANNEL_NAME,
    channel_username: CHANNEL_USERNAME,
    r2_key: `${VIDEO_ID}.mp4`,
    status: 'uploaded',
  }));
  await page.route(`**/api/videos/${VIDEO_ID}/related**`, jsonRoute({ videos: [] }));
  await page.route(`**/api/videos/${VIDEO_ID}/like`, jsonRoute({ likes: 0, liked: false }));
  await page.route(`**/api/videos/${VIDEO_ID}/tags`, jsonRoute({ tags: [] }));
  await page.route(`**/api/videos/${VIDEO_ID}/heartbeat`, (route) =>
    route.fulfill({ status: 204, body: '' }),
  );
  await page.route(`**/api/channels/${CHANNEL_USERNAME}/subscription`, jsonRoute({
    subscribed: false,
    subscriberCount: 0,
  }));
  await page.route(`**/api/videos/${VIDEO_ID}/stream**`, (route) =>
    route.fulfill({ status: 200, contentType: 'video/mp4', body: '' }),
  );
}

test.describe('comments — unauthenticated', () => {
  test('existing comments are visible to anonymous users', async ({ page }) => {
    await stubWatchApis(page);
    await page.route(`**/api/videos/${VIDEO_ID}/comments**`, jsonRoute({
      comments: [EXISTING_COMMENT],
    }));
    await page.goto(`/watch/${VIDEO_ID}`);
    await expect(page.getByText('Great video!')).toBeVisible({ timeout: 10_000 });
  });

  test('comment form is not shown (or is gated) for anonymous users', async ({ page }) => {
    await stubWatchApis(page);
    await page.route(`**/api/videos/${VIDEO_ID}/comments**`, jsonRoute({ comments: [] }));
    await page.goto(`/watch/${VIDEO_ID}`);
    // Either no textarea at all, or a sign-in prompt in place of the form.
    // We assert the textarea is NOT present, or it's replaced by an auth prompt.
    await expect(async () => {
      const hasForm = await page.getByRole('textbox', { name: /comment/i }).isVisible();
      const hasSignInPrompt = await page
        .getByText(/sign in to comment|log in to comment/i)
        .isVisible()
        .catch(() => false);
      expect(!hasForm || hasSignInPrompt).toBe(true);
    }).toPass({ timeout: 8_000 });
  });
});

test.describe('comments — authenticated', () => {
  test('authenticated user sees the comment input form', async ({ page }) => {
    await stubWatchApis(page, AUTHED_SESSION);
    await page.route(`**/api/videos/${VIDEO_ID}/comments**`, jsonRoute({ comments: [] }));
    await page.goto(`/watch/${VIDEO_ID}`);
    // A signed-in user should see a textbox or textarea to compose a comment.
    const commentInput = page
      .getByRole('textbox', { name: /comment/i })
      .or(page.locator('textarea[placeholder*="comment" i]'));
    await expect(commentInput.first()).toBeVisible({ timeout: 10_000 });
  });

  test('submitting a comment posts to the API and the comment appears', async ({ page }) => {
    await stubWatchApis(page, AUTHED_SESSION);

    const NEW_COMMENT_BODY = 'This is my E2E test comment';
    const postedComment = {
      ...EXISTING_COMMENT,
      id: 'comment-new',
      user_id: AUTHED_SESSION.user.id,
      body: NEW_COMMENT_BODY,
      author_name: AUTHED_SESSION.user.name,
    };

    // Start with an empty comment list; after POST return the new comment.
    let commentsFetches = 0;
    await page.route(`**/api/videos/${VIDEO_ID}/comments**`, (route) => {
      if (route.request().method() === 'POST') {
        return route.fulfill({
          status: 201,
          contentType: 'application/json',
          body: JSON.stringify(postedComment),
        });
      }
      commentsFetches++;
      const list = commentsFetches > 1 ? [postedComment] : [];
      return route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({ comments: list }),
      });
    });

    await page.goto(`/watch/${VIDEO_ID}`);

    const commentInput = page
      .getByRole('textbox', { name: /comment/i })
      .or(page.locator('textarea[placeholder*="comment" i]'));
    await expect(commentInput.first()).toBeVisible({ timeout: 10_000 });

    await commentInput.first().fill(NEW_COMMENT_BODY);
    await page.getByRole('button', { name: /post|submit|send/i }).click();

    // After a successful POST the new comment body must appear on the page.
    await expect(page.getByText(NEW_COMMENT_BODY, { exact: false })).toBeVisible({
      timeout: 8_000,
    });
  });
});
