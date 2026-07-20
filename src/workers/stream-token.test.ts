import { describe, it, expect, vi, beforeEach } from 'vitest';
import { generateStreamToken, restrictStreamVideo, unrestrictStreamVideo } from './stream-token';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function mockFetch(status: number, body: unknown) {
  return vi.fn().mockResolvedValue({
    ok: status >= 200 && status < 300,
    status,
    json: vi.fn().mockResolvedValue(body),
  });
}

// ---------------------------------------------------------------------------
// generateStreamToken
// ---------------------------------------------------------------------------

describe('generateStreamToken', () => {
  it('returns null when credentials are missing', async () => {
    expect(await generateStreamToken(undefined, undefined, 'uid-1')).toBeNull();
    expect(await generateStreamToken('account', undefined, 'uid-1')).toBeNull();
    expect(await generateStreamToken(undefined, 'token', 'uid-1')).toBeNull();
  });

  it('returns the token from the Stream API response', async () => {
    const fetcher = mockFetch(200, { result: { token: 'jwt.signed.token' }, success: true });
    vi.stubGlobal('fetch', fetcher);

    const result = await generateStreamToken('acc-1', 'tk-1', 'vid-1');

    expect(result).toBe('jwt.signed.token');
    const [url, opts] = fetcher.mock.calls[0] as [string, RequestInit];
    expect(url).toContain('/acc-1/stream/vid-1/token');
    expect((opts.headers as Record<string, string>)['Authorization']).toBe('Bearer tk-1');
    const requestBody = JSON.parse(opts.body as string) as { exp: number };
    expect(requestBody.exp).toBeGreaterThan(Math.floor(Date.now() / 1000));

    vi.unstubAllGlobals();
  });

  it('returns null on non-ok Stream API response', async () => {
    vi.stubGlobal('fetch', mockFetch(403, { errors: [{ message: 'forbidden' }] }));

    const result = await generateStreamToken('acc-1', 'tk-1', 'vid-1');
    expect(result).toBeNull();

    vi.unstubAllGlobals();
  });

  it('returns null when response body has no token', async () => {
    vi.stubGlobal('fetch', mockFetch(200, { result: {}, success: true }));

    const result = await generateStreamToken('acc-1', 'tk-1', 'vid-1');
    expect(result).toBeNull();

    vi.unstubAllGlobals();
  });
});

// ---------------------------------------------------------------------------
// restrictStreamVideo / unrestrictStreamVideo
// ---------------------------------------------------------------------------

describe('restrictStreamVideo', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  it('is a no-op when credentials are absent', async () => {
    const fetcher = vi.fn();
    vi.stubGlobal('fetch', fetcher);

    await restrictStreamVideo(undefined, undefined, 'vid-1');
    expect(fetcher).not.toHaveBeenCalled();

    vi.unstubAllGlobals();
  });

  it('PATCH-es the video with requireSignedURLs: true', async () => {
    const fetcher = mockFetch(200, { success: true });
    vi.stubGlobal('fetch', fetcher);

    await restrictStreamVideo('acc-1', 'tk-1', 'vid-1');

    const [url, opts] = fetcher.mock.calls[0] as [string, RequestInit];
    expect(url).toContain('/acc-1/stream/vid-1');
    const body = JSON.parse(opts.body as string) as { requireSignedURLs: boolean };
    expect(body.requireSignedURLs).toBe(true);

    vi.unstubAllGlobals();
  });

  it('does not throw on a non-ok Stream API response (fail-open)', async () => {
    vi.stubGlobal('fetch', mockFetch(500, {}));

    await expect(restrictStreamVideo('acc-1', 'tk-1', 'vid-1')).resolves.toBeUndefined();

    vi.unstubAllGlobals();
  });
});

describe('unrestrictStreamVideo', () => {
  it('PATCH-es the video with requireSignedURLs: false', async () => {
    const fetcher = mockFetch(200, { success: true });
    vi.stubGlobal('fetch', fetcher);

    await unrestrictStreamVideo('acc-1', 'tk-1', 'vid-1');

    const [, opts] = fetcher.mock.calls[0] as [string, RequestInit];
    const body = JSON.parse(opts.body as string) as { requireSignedURLs: boolean };
    expect(body.requireSignedURLs).toBe(false);

    vi.unstubAllGlobals();
  });
});
