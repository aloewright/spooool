// Cobalt media resolver (user's self-hosted instance, v11.x). Given a video URL
// it returns a direct playable stream so spooool can play any surfaced item
// inline. Used for PLAYBACK ONLY in this phase (no import/download). Cobalt
// tunnel/redirect URLs are short-lived, so resolved URLs are cached only briefly.
import { kvHash } from './feed-item';

export interface CobaltEnv {
  COBALT_URL?: string;
  COBALT_API_KEY?: string;
  CACHE: KVNamespace;
}

export interface Playable {
  kind: 'mp4' | 'hls';
  url: string;
}

export class CobaltError extends Error {}

const TTL = 5 * 60; // resolved stream URLs expire quickly

interface CobaltResponse {
  status?: string;
  url?: string;
  text?: string;
  error?: { code?: string };
  picker?: Array<{ type?: string; url?: string }>;
}

function classify(url: string): Playable {
  return { kind: url.includes('.m3u8') ? 'hls' : 'mp4', url };
}

export async function resolvePlayable(
  env: CobaltEnv,
  sourceUrl: string,
  fetcher: typeof fetch = fetch,
): Promise<Playable> {
  if (!env.COBALT_URL) throw new CobaltError('COBALT_URL is not configured');
  const res = await fetcher(`${env.COBALT_URL.replace(/\/$/, '')}/`, {
    method: 'POST',
    headers: {
      Accept: 'application/json',
      'Content-Type': 'application/json',
      ...(env.COBALT_API_KEY ? { Authorization: `Api-Key ${env.COBALT_API_KEY}` } : {}),
    },
    body: JSON.stringify({ url: sourceUrl, downloadMode: 'auto', videoQuality: '720' }),
  });
  const body = (await res.json().catch(() => ({}))) as CobaltResponse;
  switch (body.status) {
    case 'tunnel':
    case 'redirect':
    case 'stream':
      if (!body.url) throw new CobaltError('Cobalt returned no url');
      return classify(body.url);
    case 'picker': {
      const first = body.picker?.find((p) => p.type === 'video') ?? body.picker?.[0];
      if (!first?.url) throw new CobaltError('Cobalt picker had no playable');
      return classify(first.url);
    }
    default:
      throw new CobaltError(body.error?.code ?? body.text ?? `cobalt status ${body.status ?? res.status}`);
  }
}

export async function resolvePlayableCached(
  env: CobaltEnv,
  sourceUrl: string,
  fetcher: typeof fetch = fetch,
): Promise<Playable> {
  const key = `cobalt:resolve:${kvHash(sourceUrl)}`;
  const hit = await env.CACHE.get(key);
  if (hit !== null) return JSON.parse(hit) as Playable;
  const playable = await resolvePlayable(env, sourceUrl, fetcher);
  await env.CACHE.put(key, JSON.stringify(playable), { expirationTtl: TTL });
  return playable;
}
