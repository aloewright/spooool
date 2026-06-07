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

const TTL = 120; // 2 min — resolved tunnel URLs are ephemeral; keep the reuse window small to avoid serving a near-expired URL.

interface CobaltResponse {
  status?: string;
  url?: string;
  text?: string;
  error?: { code?: string };
  picker?: Array<{ type?: string; url?: string }>;
}

function classify(url: string): Playable {
  let isHls = url.includes('.m3u8');
  try {
    isHls = new URL(url).pathname.toLowerCase().endsWith('.m3u8');
  } catch {
    // keep substring fallback for non-absolute URLs
  }
  return { kind: isHls ? 'hls' : 'mp4', url };
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
  // Cobalt v11 statuses: tunnel | redirect | picker | error | local-processing. We handle tunnel/redirect/picker;
  // local-processing (client-side remux, different payload shape) intentionally falls through to the error branch
  // so the caller link-out fallback kicks in.
  switch (body.status) {
    case 'tunnel':
    case 'redirect':
      if (!body.url) throw new CobaltError('Cobalt returned no url');
      return classify(body.url);
    case 'picker': {
      const video = body.picker?.find((p) => p.type === 'video');
      if (!video?.url) throw new CobaltError('Cobalt picker had no video item');
      return classify(video.url);
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
