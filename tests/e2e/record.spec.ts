import { test, expect, type BrowserContext } from '@playwright/test';

// Smoke test for the /record → render → /watch flow.
//
// This test requires:
//
// 1. A signed-in user session. The test signs up a fresh throwaway account
//    via /signup (same pattern as auth.spec.ts). This is slow (~2 round
//    trips) but avoids any session-bypass endpoint that doesn't exist yet.
//    If a faster fixture helper is added later, replace the signup block.
//
// 2. The dev server running (npm run dev) with both the Vite frontend
//    (port 5173) and the Wrangler worker reachable. Or set
//    PLAYWRIGHT_BASE_URL to a staging deployment.
//
// 3. The render container reachable from the worker. When running purely
//    against `wrangler dev`, the container binding returns a 503 — the test
//    will pass through the record/upload steps and then time out waiting for
//    the /watch redirect. That is a useful negative-path signal.
//
// CI gate: set E2E_RUN_RECORDER=1 to run this test. It is skipped by default
// so that the normal CI suite (which runs against the staging deployment but
// does not bring a render container up) stays green.

const PASSWORD = 'playwright-recorder-e2e-1';

function uniqueEmail(): string {
  const id = crypto.randomUUID().slice(0, 8);
  return `e2e+rec+${id}@spooool-e2e.test`;
}

/** Stub getUserMedia / getDisplayMedia with a canvas-backed synthetic stream.
 *
 * Headless Chromium has no camera hardware; without this stub the recorder
 * hits the PermissionError view and the test can never reach RecordButton.
 *
 * The stub runs as an addInitScript so it executes before any page JS.
 * AudioContext + createOscillator produce a silent audio track so
 * MediaRecorder doesn't reject the stream for lacking audio.
 */
async function stubMediaDevices(context: BrowserContext): Promise<void> {
  await context.addInitScript(() => {
    const canvas = document.createElement('canvas');
    canvas.width = 640;
    canvas.height = 480;
    const ctx = canvas.getContext('2d')!;
    let frame = 0;
    const draw = (): void => {
      ctx.fillStyle = `hsl(${frame * 4}, 50%, 50%)`;
      ctx.fillRect(0, 0, 640, 480);
      frame++;
      requestAnimationFrame(draw);
    };
    draw();
    const stream = canvas.captureStream(30);

    // Add a silent audio track so MediaRecorder does not bail on missing audio.
    const audioCtx = new AudioContext();
    const dest = audioCtx.createMediaStreamDestination();
    const osc = audioCtx.createOscillator();
    osc.frequency.value = 0;
    osc.connect(dest);
    osc.start();
    stream.addTrack(dest.stream.getAudioTracks()[0]);

    const stub = async (): Promise<MediaStream> => stream;
    // @ts-expect-error — patching read-only mediaDevices in test context
    navigator.mediaDevices.getUserMedia = stub;
    // @ts-expect-error
    navigator.mediaDevices.getDisplayMedia = stub;

    // Also stub enumerateDevices so the recorder's device-picker sees one
    // synthetic video + one synthetic audio device and doesn't show the
    // "waiting for devices" splash.
    navigator.mediaDevices.enumerateDevices = async (): Promise<MediaDeviceInfo[]> => [
      {
        deviceId: 'synthetic-video',
        groupId: 'synthetic-group',
        kind: 'videoinput' as MediaDeviceKind,
        label: 'Synthetic Camera',
        toJSON: () => ({}),
      },
      {
        deviceId: 'synthetic-audio',
        groupId: 'synthetic-group',
        kind: 'audioinput' as MediaDeviceKind,
        label: 'Synthetic Microphone',
        toJSON: () => ({}),
      },
    ];
  });
}

test.describe('Recorder flow', () => {
  test.skip(
    !process.env.E2E_RUN_RECORDER,
    'set E2E_RUN_RECORDER=1 to run this test against a live stack',
  );

  test('record → upload → render → /watch redirect', async ({ page, context }) => {
    // ── 1. Stub synthetic camera before any page navigation ──────────────
    await stubMediaDevices(context);

    // ── 2. Sign up a fresh throwaway user ────────────────────────────────
    // TODO: Replace with a faster session-fixture helper once one exists
    // (e.g. a POST to /api/auth/sign-in/email with a pre-seeded test user
    // seeded in D1 by the CI workflow, or a localhost-only ?test-session
    // bypass added behind a TEST_SESSION_BYPASS env flag).
    const email = uniqueEmail();
    await page.goto('/signup');
    await page.getByLabel(/name/i).fill('E2E Recorder User');
    await page.getByLabel(/email/i).fill(email);
    await page.getByLabel(/password/i).fill(PASSWORD);
    await Promise.all([
      page.waitForURL('**/'),
      page.getByRole('button', { name: /sign up|create account/i }).click(),
    ]);

    // ── 3. Navigate to the recorder ──────────────────────────────────────
    // TODO: Add an email verification step before navigating to /record.
    // Currently this test fails at the "Start recording" selector wait because
    // /record renders the "Verify your email" gate for newly-signed-up accounts.
    // Options: (a) seed a verified user via a test fixture, (b) add a worker
    // endpoint that auto-verifies in test mode, (c) manually verify via the
    // email link in a real run.
    await page.goto('/record');

    // Wait for the recorder UI to mount. The primary indicator is the
    // "Start recording" button from RecordButton.tsx. Allow extra time for
    // the initial getUserMedia stub to settle.
    //
    // Button text when idle and camera+audio are ready: "Start recording"
    // Button text when camera/audio not yet ready:     "Select audio+video to record"
    // We wait for either — if the stub worked, the enabled form shows up.
    const startBtn = page.getByRole('button', { name: /start recording/i });
    await expect(startBtn).toBeVisible({ timeout: 15_000 });
    await expect(startBtn).toBeEnabled();

    // ── 4. Record ~2.5 seconds of synthetic video ────────────────────────
    await startBtn.click();

    // While recording, RecordButton.tsx renders "Stop recording".
    const stopBtn = page.getByRole('button', { name: /stop recording/i });
    await expect(stopBtn).toBeVisible({ timeout: 5_000 });

    await page.waitForTimeout(2_500);
    await stopBtn.click();

    // ── 5. Wait for the upload pipeline + transcription to complete ──────
    // After stopping, UseThisTake.tsx runs: convert → upload to R2 →
    // transcribe. Only after all blobs are processed does it set
    // `uploadsComplete = true` and render the "Create video" button.
    //
    // Timeout: chunked upload + transcription can take 30–90 s depending
    // on network and worker load. Use a generous ceiling.
    const createVideoBtn = page.getByRole('button', { name: /create video/i });
    await createVideoBtn.waitFor({ timeout: 90_000 });

    // ── 6. Submit the render job ─────────────────────────────────────────
    await createVideoBtn.click();

    // After clicking, UseThisTake.tsx calls createRenderJob and sets jobId,
    // which swaps the UI to <RenderProgress>. The progress indicator shows
    // "Queued…" or "Rendering N%" while the container is working.
    await expect(
      page.getByText(/queued|rendering|starting render/i),
    ).toBeVisible({ timeout: 10_000 });

    // ── 7. Wait for the render to finish and redirect to /watch ──────────
    // RenderProgress.tsx polls /api/render/:jobId every 2 s and calls
    // window.location.href = `/watch/${videoId}` on completion.
    //
    // Render container cold-starts can take 2–5 minutes; use 6 min ceiling.
    await page.waitForURL(/\/watch\//, { timeout: 6 * 60_000 });

    // Minimal sanity-check: the /watch page should contain a video element.
    // The player is video.js; it renders a <video> tag synchronously.
    await expect(page.locator('video').first()).toBeAttached({ timeout: 10_000 });
  });
});
