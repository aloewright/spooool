import { Hono } from 'hono';
import { beforeEach, describe, expect, it } from 'vitest';
import { channelRoutes, type ChannelEnv } from './channels';

interface UserRow {
  id: string;
  email: string;
  name: string;
  username: string | null;
  displayName: string | null;
  bio: string | null;
  avatarUrl: string | null;
  bannerUrl: string | null;
}

interface VideoRow {
  id: string;
  user_id: string;
  title: string;
  description: string | null;
  stream_video_id: string | null;
  status: string;
  view_count: number;
  thumbnail_url: string | null;
  created_at: number;
  deleted_at: number | null;
}

interface SubRow {
  channel_user_id: string;
  subscriber_user_id: string;
}

interface Store {
  users: UserRow[];
  videos: VideoRow[];
  subscriptions: SubRow[];
}

interface PreparedStmt {
  bind(...values: unknown[]): PreparedStmt;
  first<T = unknown>(): Promise<T | null>;
  all<T = unknown>(): Promise<{ results: T[] }>;
  run(): Promise<{ success: boolean }>;
}

function fakeDB(store: Store): D1Database {
  const flat = (sql: string): string => sql.replace(/\s+/g, ' ').trim();
  function prepare(sql: string): PreparedStmt {
    const q = flat(sql);
    let args: unknown[] = [];
    const stmt: PreparedStmt = {
      bind(...values) {
        args = values;
        return stmt;
      },
      async first<T>() {
        if (q.startsWith('SELECT u.id, u.email, u.name, u.username')) {
          const [username] = args as [string];
          const u = store.users.find((x) => x.username === username);
          if (!u) return null;
          const subscriberCount = store.subscriptions.filter((s) => s.channel_user_id === u.id).length;
          const videoCount = store.videos.filter((v) => v.user_id === u.id && v.deleted_at === null).length;
          return { ...u, subscriberCount, videoCount } as unknown as T;
        }
        if (q.startsWith('SELECT id FROM user WHERE username = ?')) {
          const [username] = args as [string];
          const u = store.users.find((x) => x.username === username);
          return (u ? ({ id: u.id } as unknown as T) : null);
        }
        throw new Error(`unexpected first query: ${q}`);
      },
      async all<T>() {
        if (q.startsWith('SELECT id, title, description, stream_video_id, status, view_count, thumbnail_url, created_at FROM videos')) {
          const [userId, limit, offset] = args as [string, number, number];
          const rows = store.videos
            .filter((v) => v.user_id === userId && v.deleted_at === null)
            .sort((a, b) => b.created_at - a.created_at)
            .slice(offset, offset + limit)
            .map((v) => ({
              id: v.id,
              title: v.title,
              description: v.description,
              stream_video_id: v.stream_video_id,
              status: v.status,
              view_count: v.view_count,
              thumbnail_url: v.thumbnail_url,
              created_at: v.created_at,
            }));
          return { results: rows as unknown as T[] };
        }
        throw new Error(`unexpected all query: ${q}`);
      },
      async run() {
        throw new Error(`unexpected run query: ${q}`);
      },
    };
    return stmt;
  }
  return { prepare } as unknown as D1Database;
}

function buildApp() {
  const app = new Hono<{ Bindings: ChannelEnv }>();
  app.route('/', channelRoutes);
  return app;
}

describe('channelRoutes integration', () => {
  let store: Store;
  let env: ChannelEnv;

  beforeEach(() => {
    store = {
      users: [
        {
          id: 'u1',
          email: 'alice@example.com',
          name: 'Alice',
          username: 'alice',
          displayName: 'Alice A',
          bio: 'I make videos',
          avatarUrl: null,
          bannerUrl: null,
        },
      ],
      videos: [
        {
          id: 'v1',
          user_id: 'u1',
          title: 'first',
          description: 'd1',
          stream_video_id: 's1',
          status: 'ready',
          view_count: 10,
          thumbnail_url: null,
          created_at: 1,
          deleted_at: null,
        },
        {
          id: 'v2',
          user_id: 'u1',
          title: 'second',
          description: null,
          stream_video_id: 's2',
          status: 'ready',
          view_count: 5,
          thumbnail_url: null,
          created_at: 2,
          deleted_at: null,
        },
        {
          id: 'v3',
          user_id: 'u1',
          title: 'deleted',
          description: null,
          stream_video_id: 's3',
          status: 'ready',
          view_count: 0,
          thumbnail_url: null,
          created_at: 3,
          deleted_at: 99,
        },
      ],
      subscriptions: [
        { channel_user_id: 'u1', subscriber_user_id: 'u2' },
        { channel_user_id: 'u1', subscriber_user_id: 'u3' },
      ],
    };
    env = { DB: fakeDB(store) };
  });

  describe('GET /api/channels/:username', () => {
    it('returns header with subscriber + video counts', async () => {
      const res = await buildApp().request('/api/channels/alice', {}, env);
      expect(res.status).toBe(200);
      const body = (await res.json()) as Record<string, unknown>;
      expect(body.id).toBe('u1');
      expect(body.username).toBe('alice');
      expect(body.displayName).toBe('Alice A');
      expect(body.bio).toBe('I make videos');
      expect(body.subscriberCount).toBe(2);
      expect(body.videoCount).toBe(2);
    });

    it('falls back to name when displayName is null', async () => {
      store.users[0].displayName = null;
      const res = await buildApp().request('/api/channels/alice', {}, env);
      const body = (await res.json()) as { displayName: string };
      expect(body.displayName).toBe('Alice');
    });

    it('returns 404 for unknown username', async () => {
      const res = await buildApp().request('/api/channels/ghost', {}, env);
      expect(res.status).toBe(404);
    });
  });

  describe('GET /api/channels/:username/videos', () => {
    it('returns paginated videos newest-first, excluding deleted', async () => {
      const res = await buildApp().request('/api/channels/alice/videos', {}, env);
      expect(res.status).toBe(200);
      const body = (await res.json()) as {
        page: number;
        limit: number;
        videos: Array<{ id: string }>;
      };
      expect(body.page).toBe(1);
      expect(body.limit).toBe(24);
      expect(body.videos.map((v) => v.id)).toEqual(['v2', 'v1']);
    });

    it('honors page + limit query params', async () => {
      const res = await buildApp().request('/api/channels/alice/videos?page=2&limit=1', {}, env);
      const body = (await res.json()) as { videos: Array<{ id: string }> };
      expect(body.videos.map((v) => v.id)).toEqual(['v1']);
    });

    it('returns 400 when query params are invalid', async () => {
      const res = await buildApp().request('/api/channels/alice/videos?limit=999', {}, env);
      expect(res.status).toBe(400);
    });

    it('returns 404 for unknown channel', async () => {
      const res = await buildApp().request('/api/channels/ghost/videos', {}, env);
      expect(res.status).toBe(404);
    });
  });
});
