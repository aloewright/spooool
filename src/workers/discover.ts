import { Hono } from 'hono';
import { z } from 'zod';
import {
  assembleByRank,
  assembleFeed,
  type FeedItem,
  type SourceResult,
} from './feed-item';
import { getYouTubeSearchItems, type YouTubeEnv } from './youtube';
import { getDailyMotionSearchItems, type DailyMotionEnv } from './dailymotion';
import { getBraveVideoSearchItems, type BraveEnv } from './brave';
import { getFirecrawlVideoItems, type FirecrawlEnv } from './firecrawl';
import { resolvePlayableCached, type CobaltEnv } from './cobalt';

export type ProviderKey = 'youtube' | 'dailymotion' | 'brave' | 'firecrawl';
export const ALL_PROVIDERS: ProviderKey[] = ['youtube', 'dailymotion', 'brave', 'firecrawl'];

export interface DiscoverEnv extends YouTubeEnv, DailyMotionEnv, BraveEnv, FirecrawlEnv, CobaltEnv {}

type SessionUser = { id: string } | null;
type DiscoverVars = { user: SessionUser };

export interface AggregateOptions {
  q: string;
  providers: ProviderKey[];
  order: 'relevance' | 'date';
  cursor: string | null;
  limit: number;
}

export interface DiscoverResult {
  items: FeedItem[];
  nextCursor: string | null;
  providers: Array<{ key: ProviderKey; error?: string; stale?: boolean }>;
}

async function runProvider(
  env: DiscoverEnv,
  key: ProviderKey,
  q: string,
  fetcher: typeof fetch,
): Promise<{ key: ProviderKey; items: FeedItem[]; error?: string; stale?: boolean }> {
  try {
    const r =
      key === 'youtube'
        ? await getYouTubeSearchItems(env, q, fetcher)
        : key === 'dailymotion'
          ? await getDailyMotionSearchItems(env, q, fetcher)
          : key === 'brave'
            ? await getBraveVideoSearchItems(env, q, fetcher)
            : await getFirecrawlVideoItems(env, q, fetcher);
    return { key, items: r.items, error: r.error, stale: r.stale };
  } catch (err) {
    return { key, items: [], error: err instanceof Error ? err.message : 'provider failed' };
  }
}

export async function aggregateSearch(
  env: DiscoverEnv,
  opts: AggregateOptions,
  fetcher: typeof fetch = fetch,
): Promise<DiscoverResult> {
  const selected = opts.providers.filter((p) => ALL_PROVIDERS.includes(p));
  const settled = await Promise.allSettled(selected.map((k) => runProvider(env, k, opts.q, fetcher)));
  const perProvider = settled.map((s, i) =>
    s.status === 'fulfilled' ? s.value : { key: selected[i], items: [] as FeedItem[], error: 'provider rejected' },
  );

  const providers = perProvider.map(({ key, error, stale }) => ({ key, ...(error ? { error } : {}), ...(stale ? { stale: true } : {}) }));

  if (opts.order === 'date') {
    const results: SourceResult[] = perProvider.map((p) => ({
      sourceId: p.key,
      kind: 'web_search' as const,
      items: p.items,
    }));
    const assembled = assembleFeed(results, opts.cursor, opts.limit);
    return { items: assembled.items, nextCursor: assembled.nextCursor, providers };
  }

  const ranked = assembleByRank(perProvider.map((p) => p.items), opts.cursor, opts.limit);
  return { items: ranked.items, nextCursor: ranked.nextCursor, providers };
}

// SSRF guard: only allow http(s) URLs to public hosts. Blocks localhost,
// link-local, and private IP ranges so a logged-in user can't make the Cobalt
// instance probe internal services.
export function isResolvableUrl(raw: string): boolean {
  let u: URL;
  try {
    u = new URL(raw);
  } catch {
    return false;
  }
  if (u.protocol !== 'https:' && u.protocol !== 'http:') return false;
  const host = u.hostname.toLowerCase();
  if (host === 'localhost' || host === '0.0.0.0' || host.endsWith('.local') || host.endsWith('.internal')) {
    return false;
  }
  // IPv6 loopback / unique-local
  if (host === '::1' || host.startsWith('fc') || host.startsWith('fd') || host.startsWith('fe80')) return false;
  // IPv4 private / loopback / link-local ranges
  const m = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(host);
  if (m) {
    const [a, b] = [Number(m[1]), Number(m[2])];
    if (a === 10 || a === 127 || a === 0) return false;
    if (a === 169 && b === 254) return false; // link-local incl. cloud metadata
    if (a === 192 && b === 168) return false;
    if (a === 172 && b >= 16 && b <= 31) return false;
  }
  return true;
}

const searchSchema = z.object({
  q: z.string().trim().min(1).max(256),
  providers: z.string().optional(),
  order: z.enum(['relevance', 'date']).default('relevance'),
  cursor: z.string().optional(),
  limit: z.coerce.number().int().positive().max(50).default(15),
});

function parseProviders(csv: string | undefined): ProviderKey[] {
  if (!csv) return ALL_PROVIDERS;
  const parts = csv.split(',').map((s) => s.trim()) as ProviderKey[];
  const valid = parts.filter((p) => ALL_PROVIDERS.includes(p));
  return valid.length ? valid : ALL_PROVIDERS;
}

export const discoverRoutes = new Hono<{ Bindings: DiscoverEnv; Variables: DiscoverVars }>();

discoverRoutes.get('/api/discover/search', async (c) => {
  if (!c.get('user')) return c.json({ error: 'Unauthorized' }, 401);
  const parsed = searchSchema.safeParse(c.req.query());
  if (!parsed.success) return c.json({ error: 'Invalid query', details: parsed.error.flatten() }, 400);
  const result = await aggregateSearch(c.env, {
    q: parsed.data.q,
    providers: parseProviders(parsed.data.providers),
    order: parsed.data.order,
    cursor: parsed.data.cursor ?? null,
    limit: parsed.data.limit,
  });
  return c.json(result);
});

discoverRoutes.get('/api/discover/resolve', async (c) => {
  if (!c.get('user')) return c.json({ error: 'Unauthorized' }, 401);
  const url = c.req.query('url');
  if (!url) return c.json({ error: 'Missing url' }, 400);
  if (!isResolvableUrl(url)) return c.json({ error: 'URL not allowed' }, 400);
  try {
    const playable = await resolvePlayableCached(c.env, url);
    return c.json(playable);
  } catch (err) {
    return c.json({ error: err instanceof Error ? err.message : 'resolve failed' }, 502);
  }
});
