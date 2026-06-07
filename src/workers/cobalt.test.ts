import { describe, expect, it } from 'vitest';
import { resolvePlayable, resolvePlayableCached, CobaltError } from './cobalt';

function env(url = 'https://cobalt-api.lazee.workers.dev') {
  const store = new Map<string, string>();
  return {
    COBALT_URL: url,
    CACHE: {
      get: async (k: string) => store.get(k) ?? null,
      put: async (k: string, v: string) => void store.set(k, v),
      delete: async (k: string) => void store.delete(k),
    } as unknown as KVNamespace,
    store,
  };
}
const ok = (body: unknown) =>
  (async () => new Response(JSON.stringify(body), { status: 200 })) as unknown as typeof fetch;

describe('resolvePlayable', () => {
  it('maps tunnel/redirect to mp4', async () => {
    const r = await resolvePlayable(env(), 'https://x/y', ok({ status: 'tunnel', url: 'https://cdn/v.mp4' }));
    expect(r).toEqual({ kind: 'mp4', url: 'https://cdn/v.mp4' });
  });
  it('detects hls by .m3u8', async () => {
    const r = await resolvePlayable(env(), 'https://x/y', ok({ status: 'redirect', url: 'https://cdn/v.m3u8' }));
    expect(r.kind).toBe('hls');
  });
  it('picks first video from a picker', async () => {
    const r = await resolvePlayable(env(), 'https://x/y', ok({
      status: 'picker',
      picker: [{ type: 'photo', url: 'p' }, { type: 'video', url: 'https://cdn/pick.mp4' }],
    }));
    expect(r.url).toBe('https://cdn/pick.mp4');
  });
  it('throws CobaltError when picker has no video item', async () => {
    await expect(
      resolvePlayable(env(), 'https://x/y', ok({ status: 'picker', picker: [{ type: 'photo', url: 'p' }] })),
    ).rejects.toBeInstanceOf(CobaltError);
  });
  it('throws CobaltError on local-processing status (link-out fallback path)', async () => {
    await expect(
      resolvePlayable(env(), 'https://x/y', ok({ status: 'local-processing', url: 'https://x/y.mp4' })),
    ).rejects.toBeInstanceOf(CobaltError);
  });
  it('throws CobaltError on error status', async () => {
    await expect(
      resolvePlayable(env(), 'https://x/y', ok({ status: 'error', error: { code: 'fetch.fail' } })),
    ).rejects.toBeInstanceOf(CobaltError);
  });
  it('throws when COBALT_URL is empty or missing', async () => {
    await expect(resolvePlayable(env(''), 'https://x/y', ok({}))).rejects.toBeInstanceOf(CobaltError);
  });
});

describe('resolvePlayableCached', () => {
  it('caches the resolved playable by url', async () => {
    const e = env();
    let calls = 0;
    const fetcher = (async () => {
      calls++;
      return new Response(JSON.stringify({ status: 'tunnel', url: 'https://cdn/v.mp4' }), { status: 200 });
    }) as unknown as typeof fetch;
    await resolvePlayableCached(e, 'https://x/y', fetcher);
    await resolvePlayableCached(e, 'https://x/y', fetcher);
    expect(calls).toBe(1);
  });
});
