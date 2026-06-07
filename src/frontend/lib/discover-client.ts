// Typed client for the discover API (src/workers/discover.ts). Same-origin
// credentials so the better-auth session cookie is sent.
import type { FeedItem } from './feeds-client';

export type ProviderKey = 'youtube' | 'dailymotion' | 'brave' | 'firecrawl';
export const ALL_PROVIDERS: ProviderKey[] = ['youtube', 'dailymotion', 'brave', 'firecrawl'];

export interface DiscoverResponse {
  items: FeedItem[];
  nextCursor: string | null;
  providers: Array<{ key: ProviderKey; error?: string; stale?: boolean }>;
}

export interface Playable {
  kind: 'mp4' | 'hls';
  url: string;
}

async function json<T>(res: Response): Promise<T> {
  if (!res.ok) {
    const body = (await res.json().catch(() => null)) as { error?: string } | null;
    throw new Error(body?.error ?? `Request failed (${res.status})`);
  }
  return (await res.json()) as T;
}

export async function searchDiscover(params: {
  q: string;
  providers?: ProviderKey[];
  order?: 'relevance' | 'date';
  cursor?: string;
}): Promise<DiscoverResponse> {
  const qs = new URLSearchParams({ q: params.q });
  if (params.providers?.length) qs.set('providers', params.providers.join(','));
  if (params.order) qs.set('order', params.order);
  if (params.cursor) qs.set('cursor', params.cursor);
  return json<DiscoverResponse>(await fetch(`/api/discover/search?${qs}`, { credentials: 'same-origin' }));
}

export async function resolvePlayable(url: string): Promise<Playable> {
  return json<Playable>(
    await fetch(`/api/discover/resolve?url=${encodeURIComponent(url)}`, { credentials: 'same-origin' }),
  );
}
