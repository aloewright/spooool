import { Hono } from 'hono';
import { describe, expect, it } from 'vitest';
import { channelRoutes, type ChannelEnv } from './channels';

interface FakeStmt {
  bind: (...values: unknown[]) => FakeStmt;
  first: <T>() => Promise<T | null>;
  all: <T>() => Promise<{ results: T[] }>;
  run: () => Promise<{ success: boolean }>;
}

interface ChannelRow {
  id: string;
  email: string;
  name: string;
  username: string | null;
  displayName: string | null;
  bio: string | null;
  avatarUrl: string | null;
  bannerUrl: string | null;
  subscriberCount: number;
  videoCount: number;
  totalViewCount: number;
}

interface VideoRow {
  id: string;
  title: string;
  description: string | null;
  stream_video_id: string | null;
  status: string;
  view_count: number;
  thumbnail_url: string | null;
  created_at: string;
}

interface FakeDBSpec {
  channel?: ChannelRow | null;
  // username → channel id lookup used by the videos route.
  ownerByUsername?: Record<string, { id: string }>;
  videos?: VideoRow[];
}

function fakeDB(spec: FakeDBSpec): D1Database {
  const prepare = (sql: string): FakeStmt => {
    let bound: unknown[] = [];
    const stmt: FakeStmt = {
      bind: (...values) => {
        bound = values;
        return stmt;
      },
      first: async () => {
        // Header query joins user + subqueries; we only branch on the WHERE.
        if (sql.includes('FROM user u') && sql.includes('subscriberCount')) {
          return (spec.channel ?? null) as never;
        }
        if (sql.includes('SELECT id FROM user WHERE username')) {
          const username = bound[0] as string;
          return (spec.ownerByUsername?.[username] ?? null) as never;
        }
        return null;
      },
      all: async () => {
        return { results: (spec.videos ?? []) as never[] };
      },
      run: async () => ({ success: true }),
    };
    return stmt;
  };
  return { prepare } as unknown as D1Database;
}

function buildApp(db: D1Database) {
  const app = new Hono<{ Bindings: ChannelEnv }>();
  app.route('/', channelRoutes);
  // hono's app.request takes Bindings as the 3rd arg
  return (path: string, init?: RequestInit) => app.request(path, init, { DB: db });
}

describe('GET /api/channels/:username', () => {
  it('returns 404 when the channel does not exist', async () => {
    const req = buildApp(fakeDB({ channel: null }));
    const res = await req('/api/channels/nobody');
    expect(res.status).toBe(404);
  });

  it('falls back to user.name when displayName is null', async () => {
    const req = buildApp(
      fakeDB({
        channel: {
          id: 'u1',
          email: 'a@b.test',
          name: 'Alice',
          username: 'alice',
          displayName: null,
          bio: null,
          avatarUrl: null,
          bannerUrl: null,
          subscriberCount: 3,
          videoCount: 5,
          totalViewCount: 42,
        },
      }),
    );
    const res = await req('/api/channels/alice');
    expect(res.status).toBe(200);
    const body = (await res.json()) as { displayName: string };
    expect(body.displayName).toBe('Alice');
  });

  it('coerces count fields to numbers and never exposes email', async () => {
    const req = buildApp(
      fakeDB({
        channel: {
          id: 'u2',
          email: 'secret@example.test',
          name: 'Bob',
          username: 'bob',
          displayName: 'Bob B.',
          bio: 'hi',
          avatarUrl: 'https://cdn/x.png',
          bannerUrl: null,
          // D1 returns counts as strings in some drivers; coerce should handle both.
          subscriberCount: '12' as unknown as number,
          videoCount: '4' as unknown as number,
          totalViewCount: '99' as unknown as number,
        },
      }),
    );
    const res = await req('/api/channels/bob');
    const body = (await res.json()) as Record<string, unknown>;
    expect(body.subscriberCount).toBe(12);
    expect(body.videoCount).toBe(4);
    expect(body.totalViewCount).toBe(99);
    expect(body).not.toHaveProperty('email');
  });
});

describe('GET /api/channels/:username/videos', () => {
  it('returns 400 for invalid pagination', async () => {
    const req = buildApp(fakeDB({}));
    const res = await req('/api/channels/alice/videos?page=0');
    expect(res.status).toBe(400);
  });

  it('rejects limit above 50', async () => {
    const req = buildApp(fakeDB({}));
    const res = await req('/api/channels/alice/videos?limit=999');
    expect(res.status).toBe(400);
  });

  it('returns 404 when the channel owner is missing', async () => {
    const req = buildApp(fakeDB({ ownerByUsername: {} }));
    const res = await req('/api/channels/ghost/videos');
    expect(res.status).toBe(404);
  });

  it('returns the video list with echoed page/limit', async () => {
    const videos: VideoRow[] = [
      {
        id: 'v1',
        title: 'one',
        description: null,
        stream_video_id: null,
        status: 'ready',
        view_count: 9,
        thumbnail_url: null,
        created_at: '2025-01-01',
      },
    ];
    const req = buildApp(
      fakeDB({ ownerByUsername: { alice: { id: 'u1' } }, videos }),
    );
    const res = await req('/api/channels/alice/videos?page=2&limit=10');
    expect(res.status).toBe(200);
    const body = (await res.json()) as { page: number; limit: number; videos: VideoRow[] };
    expect(body.page).toBe(2);
    expect(body.limit).toBe(10);
    expect(body.videos).toEqual(videos);
  });
});
