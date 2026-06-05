// @vitest-environment happy-dom
//
// Verifies that when a video row has stream_video_id + status:'ready' the
// Watch page renders the Cloudflare Stream iframe — the surface through
// which HLS ABR variants are served — rather than the "still encoding"
// placeholder.
//
// What this covers:
//   1. StreamPlayer is mounted (vs. placeholder div) for a ready Stream video.
//   2. The iframe src matches the customer-scoped cloudflarestream.com URL
//      with the correct video UID.
//   3. controls=true param forwarded; controls=false is absent (default).
//   4. When stream_video_id is absent (encoding state) no iframe is rendered.
//
// What this does NOT cover:
//   - ABR quality-switching inside the cross-origin iframe (opaque to JS).
//   - Bandwidth throttle tests (require a real browser + real network; see
//     Findings in the verification report).

import { act } from 'react';
import ReactDOM from 'react-dom/client';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const STREAM_VIDEO_UID = 'abc123def456789012345678901234ab';
const VIDEO_ID = 'test-video-watch-abr';

// The @cloudflare/stream-react <Stream> component only renders the <iframe>
// once window.Stream (the Cloudflare embed SDK) is defined. In happy-dom the
// script injection never fires a load event, so we stub the SDK as a no-op
// function (truthy value is all the SDK gate checks).
function installStreamSdkStub() {
  (window as unknown as Record<string, unknown>).Stream = function StreamStub() {
    return {
      addEventListener: () => {},
      removeEventListener: () => {},
    };
  };
}

function stubFetch(videoOverrides: Record<string, unknown> = {}) {
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url: string) => {
      const base: Record<string, unknown> = {
        id: VIDEO_ID,
        title: 'ABR test video',
        description: '',
        view_count: 1,
        channel_name: 'Test Channel',
        channel_username: 'test-channel',
        stream_video_id: STREAM_VIDEO_UID,
        status: 'ready',
      };
      if (url.includes('/api/auth/get-session')) {
        return new Response('null', { status: 200, headers: { 'content-type': 'application/json' } });
      }
      if (url.includes(`/api/videos/${VIDEO_ID}`) && !url.includes('/like') && !url.includes('/comment') && !url.includes('/related') && !url.includes('/tags') && !url.includes('/heartbeat')) {
        return new Response(
          JSON.stringify({ ...base, ...videoOverrides }),
          { status: 200, headers: { 'content-type': 'application/json' } },
        );
      }
      return new Response(
        JSON.stringify({ items: [], videos: [], comments: [], tags: [], liked: false, count: 0, subscribed: false, subscriberCount: 0 }),
        { status: 200, headers: { 'content-type': 'application/json' } },
      );
    }),
  );
}

async function mountWatch(videoId: string): Promise<{ container: HTMLDivElement; root: ReactDOM.Root }> {
  installStreamSdkStub();

  const container = document.createElement('div');
  document.body.appendChild(container);

  const { Watch } = await import('./Watch');
  let root!: ReactDOM.Root;

  await act(async () => {
    root = ReactDOM.createRoot(container);
    root.render(
      <MemoryRouter initialEntries={[`/watch/${videoId}`]}>
        <Routes>
          <Route path="/watch/:id" element={<Watch />} />
        </Routes>
      </MemoryRouter>,
    );
  });

  // Allow the fetch + setState + re-render cycle to settle.
  for (let i = 0; i < 8; i++) {
    await act(async () => {
      await new Promise((r) => setTimeout(r, 50));
    });
  }

  return { container, root };
}

describe('Watch — Stream ABR iframe path', () => {
  let container: HTMLDivElement | null = null;
  let root: ReactDOM.Root | null = null;

  afterEach(() => {
    if (root) {
      act(() => { root!.unmount(); });
      root = null;
    }
    if (container) {
      container.remove();
      container = null;
    }
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
    delete (window as unknown as Record<string, unknown>).Stream;
  });

  it('renders a Cloudflare Stream iframe when stream_video_id is present and status is ready', async () => {
    stubFetch();
    ({ container, root } = await mountWatch(VIDEO_ID));

    // @cloudflare/stream-react injects an <iframe> with src:
    //   https://customer-{code}.cloudflarestream.com/{uid}/iframe?...
    const iframe = container.querySelector('iframe');
    expect(iframe, 'expected an <iframe> for the Cloudflare Stream player').not.toBeNull();

    const src = iframe!.getAttribute('src') ?? '';
    expect(src, `iframe src "${src}" should contain cloudflarestream.com`).toContain('cloudflarestream.com');
    expect(src, `iframe src should contain the video UID "${STREAM_VIDEO_UID}"`).toContain(STREAM_VIDEO_UID);
    // stream-player.tsx passes customerCode='od6lvjm5bwfl1lki' → customer subdomain
    expect(src, 'iframe src should use the customer subdomain').toContain('customer-od6lvjm5bwfl1lki');
  });

  it('iframe src does not include controls=false (controls are enabled by default)', async () => {
    stubFetch();
    ({ container, root } = await mountWatch(VIDEO_ID));

    const iframe = container.querySelector('iframe');
    expect(iframe).not.toBeNull();
    const src = iframe!.getAttribute('src') ?? '';
    expect(src).not.toContain('controls=false');
  });

  it('does NOT render an iframe when stream_video_id is absent and status is encoding', async () => {
    stubFetch({ stream_video_id: null, status: 'encoding' });
    ({ container, root } = await mountWatch(VIDEO_ID));

    const iframe = container.querySelector('iframe');
    expect(iframe, 'no iframe expected while video is still encoding').toBeNull();

    // Watch.tsx renders this text when status !== 'ready'
    expect(container.textContent).toContain('still encoding');
  });
});
