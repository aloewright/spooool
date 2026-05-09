import { Hono } from 'hono';
import { beforeEach, describe, expect, it } from 'vitest';
import {
  escapeXml,
  isOgViewable,
  ogImageCacheKey,
  ogImageRoutes,
  OG_CARD_HEIGHT,
  OG_CARD_WIDTH,
  renderOgCardSvg,
  wrapTitle,
  type OgImageEnv,
} from './og-image';

describe('escapeXml', () => {
  it('escapes the five XML metacharacters', () => {
    expect(escapeXml(`& < > " '`)).toBe('&amp; &lt; &gt; &quot; &apos;');
  });
});

describe('wrapTitle', () => {
  it('returns an empty array on empty input', () => {
    expect(wrapTitle('')).toEqual([]);
    expect(wrapTitle('   ')).toEqual([]);
  });

  it('keeps a short title on one line', () => {
    expect(wrapTitle('hello world')).toEqual(['hello world']);
  });

  it('wraps to multiple lines on whitespace', () => {
    const out = wrapTitle('one two three four five six seven eight', { lineLimit: 12, maxLines: 4 });
    expect(out.length).toBeGreaterThan(1);
    for (const line of out) expect(line.length).toBeLessThanOrEqual(12);
  });

  it('truncates with an ellipsis when the title overflows the line cap', () => {
    const out = wrapTitle('alpha bravo charlie delta echo foxtrot golf hotel', {
      lineLimit: 6,
      maxLines: 2,
    });
    expect(out).toHaveLength(2);
    expect(out[out.length - 1].endsWith('…')).toBe(true);
  });

  it('breaks a single very long word at the line limit', () => {
    const out = wrapTitle('a'.repeat(40), { lineLimit: 10, maxLines: 2 });
    expect(out).toHaveLength(1);
    expect(out[0]).toBe(`${'a'.repeat(9)}…`);
    expect(out[0].length).toBe(10);
  });
});

describe('renderOgCardSvg', () => {
  it('emits a 1200x630 SVG root with the brand title', () => {
    const svg = renderOgCardSvg({ title: 'A great clip', channelName: 'Alice' });
    expect(svg).toContain(`width="${OG_CARD_WIDTH}"`);
    expect(svg).toContain(`height="${OG_CARD_HEIGHT}"`);
    expect(svg).toContain('>spooool<');
    expect(svg).toContain('>A great clip<');
    expect(svg).toContain('>Alice<');
  });

  it('XML-escapes hostile titles and channel names', () => {
    const svg = renderOgCardSvg({
      title: 'Tom & Jerry <fight!>',
      channelName: 'O"Brien',
    });
    expect(svg).toContain('&amp;');
    expect(svg).toContain('&lt;fight!&gt;');
    expect(svg).toContain('O&quot;Brien');
    expect(svg).not.toContain('<fight!>');
  });

  it('falls back to spooool when the channel name is empty', () => {
    const svg = renderOgCardSvg({ title: 'x', channelName: null });
    expect(svg).toContain('>spooool<');
  });
});

describe('isOgViewable', () => {
  const base = {
    id: 'v1',
    title: 't',
    status: 'ready' as string | null,
    hidden_at: null as string | null,
    dmca_status: null as string | null,
    deleted_at: null as string | null,
    channel_name: null as string | null,
    channel_username: null as string | null,
  };

  it('passes ready, non-DMCA, non-deleted videos', () => {
    expect(isOgViewable({ ...base })).toBe(true);
  });

  it('still renders cards for hidden videos so admin/owner share previews keep working', () => {
    expect(isOgViewable({ ...base, hidden_at: '2026-01-01' })).toBe(true);
  });

  it('rejects deleted videos', () => {
    expect(isOgViewable({ ...base, deleted_at: '2026-01-01' })).toBe(false);
  });

  it('rejects DMCA-disabled videos', () => {
    expect(isOgViewable({ ...base, dmca_status: 'disabled' })).toBe(false);
  });
});

interface VideoRow {
  id: string;
  title: string;
  status: string | null;
  hidden_at: string | null;
  dmca_status: string | null;
  deleted_at: string | null;
}

interface UserRow {
  id: string;
  name: string | null;
  username: string | null;
}

interface Store {
  videos: VideoRow[];
  users: UserRow[];
  videoUserId: Map<string, string>;
}

interface PreparedStmt {
  bind(...values: unknown[]): PreparedStmt;
  first<T = unknown>(): Promise<T | null>;
  all<T = unknown>(): Promise<{ results: T[] }>;
  run(): Promise<{ success: boolean }>;
}

function fakeDB(store: Store): D1Database {
  function prepare(sql: string): PreparedStmt {
    const flat = sql.replace(/\s+/g, ' ').trim();
    let args: unknown[] = [];
    const stmt: PreparedStmt = {
      bind(...values: unknown[]) {
        args = values;
        return stmt;
      },
      async first<T>(): Promise<T | null> {
        if (flat.startsWith('SELECT v.id, v.title, v.status')) {
          const [id] = args as [string];
          const v = store.videos.find((x) => x.id === id);
          if (!v) return null;
          const ownerId = store.videoUserId.get(id) ?? null;
          const owner = ownerId ? store.users.find((u) => u.id === ownerId) : null;
          return {
            id: v.id,
            title: v.title,
            status: v.status,
            hidden_at: v.hidden_at,
            dmca_status: v.dmca_status,
            deleted_at: v.deleted_at,
            channel_name: owner?.name ?? null,
            channel_username: owner?.username ?? null,
          } as unknown as T;
        }
        return null;
      },
      async all<T>(): Promise<{ results: T[] }> {
        return { results: [] };
      },
      async run(): Promise<{ success: boolean }> {
        return { success: true };
      },
    };
    return stmt;
  }
  return {
    prepare,
  } as unknown as D1Database;
}

function fakeKV(): KVNamespace {
  const store = new Map<string, string>();
  return {
    async get(key: string) {
      return store.get(key) ?? null;
    },
    async put(key: string, value: string) {
      store.set(key, value);
    },
    async delete(key: string) {
      store.delete(key);
    },
  } as unknown as KVNamespace;
}

describe('ogImageRoutes', () => {
  let app: Hono<{ Bindings: OgImageEnv }>;
  let env: OgImageEnv;
  let store: Store;

  beforeEach(() => {
    store = {
      videos: [
        { id: 'v1', title: 'Hello world', status: 'ready', hidden_at: null, dmca_status: null, deleted_at: null },
        { id: 'gone', title: 't', status: 'ready', hidden_at: null, dmca_status: null, deleted_at: '2026-01-01' },
      ],
      users: [{ id: 'u1', name: 'Alice', username: 'alice' }],
      videoUserId: new Map([
        ['v1', 'u1'],
        ['gone', 'u1'],
      ]),
    };
    env = { DB: fakeDB(store), CACHE: fakeKV() };
    app = new Hono<{ Bindings: OgImageEnv }>();
    app.route('/', ogImageRoutes);
  });

  it('returns an SVG for a known video with proper headers', async () => {
    const res = await app.request('/api/og/video/v1.svg', {}, env);
    expect(res.status).toBe(200);
    expect(res.headers.get('Content-Type')).toContain('image/svg+xml');
    expect(res.headers.get('Cache-Control')).toContain('max-age=');
    const body = await res.text();
    expect(body).toContain('Hello world');
    expect(body).toContain('Alice');
  });

  it('serves cached payload on second request', async () => {
    const first = await app.request('/api/og/video/v1.svg', {}, env);
    expect(first.headers.get('x-spooool-cache')).toBe('miss');
    const second = await app.request('/api/og/video/v1.svg', {}, env);
    expect(second.headers.get('x-spooool-cache')).toBe('hit');
  });

  it('404s for unknown videos', async () => {
    const res = await app.request('/api/og/video/missing.svg', {}, env);
    expect(res.status).toBe(404);
  });

  it('404s for soft-deleted videos', async () => {
    const res = await app.request('/api/og/video/gone.svg', {}, env);
    expect(res.status).toBe(404);
  });

  it('400s for over-long ids', async () => {
    const id = 'a'.repeat(129);
    const res = await app.request(`/api/og/video/${id}.svg`, {}, env);
    expect(res.status).toBe(400);
  });
});

describe('ogImageCacheKey', () => {
  it('namespaces the key by id', () => {
    expect(ogImageCacheKey('abc')).toBe('og-image:v1:abc');
  });
});
