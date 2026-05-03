import { Hono } from 'hono';
import { beforeEach, describe, expect, it } from 'vitest';
import { commentRoutes, type CommentsEnv } from './comments';

interface CommentRow {
  id: string;
  video_id: string;
  user_id: string | null;
  parent_comment_id: string | null;
  body: string;
  created_at: string;
  updated_at: string;
  deleted_at: string | null;
}

interface VideoRow {
  id: string;
  deleted_at: string | null;
}

interface UserRow {
  id: string;
  name: string | null;
  username: string | null;
}

interface Store {
  comments: CommentRow[];
  videos: VideoRow[];
  users: UserRow[];
  now: () => string;
}

function makeStore(initial?: Partial<Store>): Store {
  let counter = 0;
  return {
    comments: initial?.comments ?? [],
    videos: initial?.videos ?? [{ id: 'video-1', deleted_at: null }],
    users: initial?.users ?? [
      { id: 'u1', name: 'Alice', username: 'alice' },
      { id: 'u2', name: 'Bob', username: 'bob' },
    ],
    now: initial?.now ?? (() => `2026-04-30T00:00:${String(counter++).padStart(2, '0')}.000Z`),
  };
}

interface PreparedStmt {
  bind(...values: unknown[]): PreparedStmt;
  first<T = unknown>(): Promise<T | null>;
  all<T = unknown>(): Promise<{ results: T[] }>;
  run(): Promise<{ success: boolean }>;
}

// Hand-rolled SQL stub that recognizes only the queries comments.ts actually
// issues. Anything new must be added explicitly so we never silently miss a
// schema change.
function fakeDB(store: Store): D1Database {
  const flat = (sql: string): string => sql.replace(/\s+/g, ' ').trim();

  function prepare(sql: string): PreparedStmt {
    const q = flat(sql);
    let args: unknown[] = [];
    const stmt: PreparedStmt = {
      bind(...values: unknown[]) {
        args = values;
        return stmt;
      },
      async first<T>(): Promise<T | null> {
        if (q.startsWith('SELECT 1 FROM videos WHERE id = ?')) {
          const [id] = args as [string];
          const v = store.videos.find((x) => x.id === id && x.deleted_at === null);
          return (v ? ({ '1': 1 } as unknown as T) : null);
        }
        if (q.startsWith('SELECT id, parent_comment_id FROM comments')) {
          const [id, videoId] = args as [string, string];
          const c = store.comments.find(
            (x) => x.id === id && x.video_id === videoId && x.deleted_at === null,
          );
          return (c ? (({ id: c.id, parent_comment_id: c.parent_comment_id }) as unknown as T) : null);
        }
        if (q.startsWith('SELECT id, user_id, deleted_at FROM comments')) {
          const [id] = args as [string];
          const c = store.comments.find((x) => x.id === id);
          return (c
            ? (({ id: c.id, user_id: c.user_id, deleted_at: c.deleted_at }) as unknown as T)
            : null);
        }
        return null;
      },
      async all<T>(): Promise<{ results: T[] }> {
        if (q.startsWith('SELECT c.id, c.video_id, c.user_id, c.parent_comment_id, c.body')) {
          // Top-level list (parent_comment_id IS NULL) or replies (parent IN (...)).
          if (q.includes('parent_comment_id IS NULL')) {
            const [videoId, limit, offset] = args as [string, number, number];
            const sortByTop = q.includes('reply_count DESC');
            const top = store.comments.filter(
              (c) => c.video_id === videoId && c.parent_comment_id === null && c.deleted_at === null,
            );
            const enriched = top.map((c) => ({
              ...c,
              author_name: store.users.find((u) => u.id === c.user_id)?.name ?? null,
              author_username: store.users.find((u) => u.id === c.user_id)?.username ?? null,
              reply_count: store.comments.filter(
                (r) => r.parent_comment_id === c.id && r.deleted_at === null,
              ).length,
            }));
            enriched.sort((a, b) => {
              if (sortByTop && a.reply_count !== b.reply_count) {
                return b.reply_count - a.reply_count;
              }
              return b.created_at.localeCompare(a.created_at);
            });
            return { results: enriched.slice(offset, offset + limit) as unknown as T[] };
          }

          // Replies branch — parent_comment_id IN (?, ?, ...).
          const parentIds = args as string[];
          const replies = store.comments
            .filter(
              (c) => c.parent_comment_id !== null && parentIds.includes(c.parent_comment_id) && c.deleted_at === null,
            )
            .map((c) => ({
              ...c,
              author_name: store.users.find((u) => u.id === c.user_id)?.name ?? null,
              author_username: store.users.find((u) => u.id === c.user_id)?.username ?? null,
              reply_count: 0,
            }))
            .sort((a, b) => a.created_at.localeCompare(b.created_at));
          return { results: replies as unknown as T[] };
        }
        return { results: [] };
      },
      async run(): Promise<{ success: boolean }> {
        if (q.startsWith('INSERT INTO comments')) {
          const [id, videoId, userId, parentCommentId, body] = args as [
            string,
            string,
            string,
            string | null,
            string,
          ];
          const ts = store.now();
          store.comments.push({
            id,
            video_id: videoId,
            user_id: userId,
            parent_comment_id: parentCommentId,
            body,
            created_at: ts,
            updated_at: ts,
            deleted_at: null,
          });
          return { success: true };
        }
        if (q.startsWith('UPDATE comments SET body = ?')) {
          const [body, id] = args as [string, string];
          const c = store.comments.find((x) => x.id === id);
          if (c) {
            c.body = body;
            c.updated_at = store.now();
          }
          return { success: true };
        }
        if (q.startsWith('UPDATE comments SET deleted_at = CURRENT_TIMESTAMP')) {
          const [id] = args as [string];
          const c = store.comments.find((x) => x.id === id);
          if (c) {
            c.deleted_at = store.now();
            c.body = '';
            c.updated_at = c.deleted_at;
          }
          return { success: true };
        }
        return { success: true };
      },
    };
    return stmt;
  }
  return { prepare } as unknown as D1Database;
}

type SessionUser = { id: string } | null;

function buildApp(store: Store, user: SessionUser): Hono<{ Bindings: CommentsEnv; Variables: { user: SessionUser } }> {
  const app = new Hono<{ Bindings: CommentsEnv; Variables: { user: SessionUser } }>();
  app.use('*', async (c, next) => {
    c.set('user', user);
    await next();
  });
  app.route('/', commentRoutes);
  return app;
}

interface JsonRequestInit {
  method?: string;
  body?: unknown;
}

async function call(
  app: Hono<{ Bindings: CommentsEnv; Variables: { user: SessionUser } }>,
  env: CommentsEnv,
  path: string,
  init: JsonRequestInit = {},
): Promise<Response> {
  return app.request(
    path,
    {
      method: init.method ?? 'GET',
      headers: { 'content-type': 'application/json' },
      body: init.body !== undefined ? JSON.stringify(init.body) : undefined,
    },
    env,
  );
}

describe('GET /api/videos/:id/comments', () => {
  let store: Store;
  let env: CommentsEnv;

  beforeEach(() => {
    store = makeStore();
    env = { DB: fakeDB(store) };
  });

  it('returns an empty list when the video has no comments', async () => {
    const app = buildApp(store, null);
    const res = await call(app, env, '/api/videos/video-1/comments');
    expect(res.status).toBe(200);
    const body = (await res.json()) as { comments: unknown[]; sort: string; page: number; limit: number };
    expect(body).toEqual({ comments: [], page: 1, limit: 50, sort: 'new' });
  });

  it('returns top-level comments newest-first by default with author info and reply counts', async () => {
    store.comments = [
      {
        id: 'c1',
        video_id: 'video-1',
        user_id: 'u1',
        parent_comment_id: null,
        body: 'first',
        created_at: '2026-04-30T00:00:01Z',
        updated_at: '2026-04-30T00:00:01Z',
        deleted_at: null,
      },
      {
        id: 'c2',
        video_id: 'video-1',
        user_id: 'u2',
        parent_comment_id: null,
        body: 'second',
        created_at: '2026-04-30T00:00:02Z',
        updated_at: '2026-04-30T00:00:02Z',
        deleted_at: null,
      },
      {
        id: 'r1',
        video_id: 'video-1',
        user_id: 'u2',
        parent_comment_id: 'c1',
        body: 'reply to first',
        created_at: '2026-04-30T00:00:03Z',
        updated_at: '2026-04-30T00:00:03Z',
        deleted_at: null,
      },
    ];
    const app = buildApp(store, null);
    const res = await call(app, env, '/api/videos/video-1/comments');
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      comments: Array<{ id: string; reply_count: number; replies: Array<{ id: string }>; edited: boolean }>;
    };
    expect(body.comments.map((c) => c.id)).toEqual(['c2', 'c1']);
    expect(body.comments[1].reply_count).toBe(1);
    expect(body.comments[1].replies[0].id).toBe('r1');
    expect(body.comments[0].edited).toBe(false);
  });

  it('reorders top-level comments when sort=top', async () => {
    store.comments = [
      {
        id: 'c1',
        video_id: 'video-1',
        user_id: 'u1',
        parent_comment_id: null,
        body: 'one reply',
        created_at: '2026-04-30T00:00:01Z',
        updated_at: '2026-04-30T00:00:01Z',
        deleted_at: null,
      },
      {
        id: 'c2',
        video_id: 'video-1',
        user_id: 'u2',
        parent_comment_id: null,
        body: 'no replies',
        created_at: '2026-04-30T00:00:02Z',
        updated_at: '2026-04-30T00:00:02Z',
        deleted_at: null,
      },
      {
        id: 'r1',
        video_id: 'video-1',
        user_id: 'u2',
        parent_comment_id: 'c1',
        body: 'r',
        created_at: '2026-04-30T00:00:03Z',
        updated_at: '2026-04-30T00:00:03Z',
        deleted_at: null,
      },
    ];
    const app = buildApp(store, null);
    const res = await call(app, env, '/api/videos/video-1/comments?sort=top');
    const body = (await res.json()) as { comments: Array<{ id: string }> };
    expect(body.comments.map((c) => c.id)).toEqual(['c1', 'c2']);
  });

  it('marks edited=true when updated_at differs from created_at', async () => {
    store.comments = [
      {
        id: 'c1',
        video_id: 'video-1',
        user_id: 'u1',
        parent_comment_id: null,
        body: 'edited body',
        created_at: '2026-04-30T00:00:01Z',
        updated_at: '2026-04-30T00:00:99Z',
        deleted_at: null,
      },
    ];
    const app = buildApp(store, null);
    const res = await call(app, env, '/api/videos/video-1/comments');
    const body = (await res.json()) as { comments: Array<{ edited: boolean }> };
    expect(body.comments[0].edited).toBe(true);
  });

  it('rejects out-of-range query parameters', async () => {
    const app = buildApp(store, null);
    const res = await call(app, env, '/api/videos/video-1/comments?limit=9999&page=0');
    expect(res.status).toBe(400);
  });
});

describe('POST /api/videos/:id/comments', () => {
  let store: Store;
  let env: CommentsEnv;

  beforeEach(() => {
    store = makeStore();
    env = { DB: fakeDB(store) };
  });

  it('rejects unauthenticated requests with 401', async () => {
    const app = buildApp(store, null);
    const res = await call(app, env, '/api/videos/video-1/comments', {
      method: 'POST',
      body: { body: 'hello' },
    });
    expect(res.status).toBe(401);
  });

  it('inserts a top-level comment and returns its id', async () => {
    const app = buildApp(store, { id: 'u1' });
    const res = await call(app, env, '/api/videos/video-1/comments', {
      method: 'POST',
      body: { body: 'first' },
    });
    expect(res.status).toBe(201);
    const json = (await res.json()) as { id: string; body: string; parent_comment_id: string | null };
    expect(json.body).toBe('first');
    expect(json.parent_comment_id).toBeNull();
    expect(store.comments).toHaveLength(1);
    expect(store.comments[0].user_id).toBe('u1');
  });

  it('rejects empty/whitespace-only bodies as invalid input', async () => {
    const app = buildApp(store, { id: 'u1' });
    const res = await call(app, env, '/api/videos/video-1/comments', {
      method: 'POST',
      body: { body: '   ' },
    });
    expect(res.status).toBe(400);
  });

  it('blocks comments that the spam pre-filter rejects', async () => {
    const app = buildApp(store, { id: 'u1' });
    const res = await call(app, env, '/api/videos/video-1/comments', {
      method: 'POST',
      body: { body: 'http://a.com http://b.com http://c.com http://d.com http://e.com' },
    });
    expect(res.status).toBe(422);
    const json = (await res.json()) as { error: string; code: string };
    expect(json.code).toBe('link_spam');
    expect(store.comments).toHaveLength(0);
  });

  it('returns 404 when the video does not exist', async () => {
    const app = buildApp(store, { id: 'u1' });
    const res = await call(app, env, '/api/videos/missing/comments', {
      method: 'POST',
      body: { body: 'hi' },
    });
    expect(res.status).toBe(404);
  });

  it('attaches a reply to its parent', async () => {
    store.comments.push({
      id: 'c1',
      video_id: 'video-1',
      user_id: 'u1',
      parent_comment_id: null,
      body: 'parent',
      created_at: '2026-04-30T00:00:01Z',
      updated_at: '2026-04-30T00:00:01Z',
      deleted_at: null,
    });
    const app = buildApp(store, { id: 'u2' });
    const res = await call(app, env, '/api/videos/video-1/comments', {
      method: 'POST',
      body: { body: 'reply', parentCommentId: 'c1' },
    });
    expect(res.status).toBe(201);
    const json = (await res.json()) as { parent_comment_id: string | null };
    expect(json.parent_comment_id).toBe('c1');
  });

  it('rejects nested replies (more than one level deep)', async () => {
    store.comments.push(
      {
        id: 'c1',
        video_id: 'video-1',
        user_id: 'u1',
        parent_comment_id: null,
        body: 'parent',
        created_at: '2026-04-30T00:00:01Z',
        updated_at: '2026-04-30T00:00:01Z',
        deleted_at: null,
      },
      {
        id: 'r1',
        video_id: 'video-1',
        user_id: 'u2',
        parent_comment_id: 'c1',
        body: 'reply',
        created_at: '2026-04-30T00:00:02Z',
        updated_at: '2026-04-30T00:00:02Z',
        deleted_at: null,
      },
    );
    const app = buildApp(store, { id: 'u1' });
    const res = await call(app, env, '/api/videos/video-1/comments', {
      method: 'POST',
      body: { body: 'reply to a reply', parentCommentId: 'r1' },
    });
    expect(res.status).toBe(400);
  });

  it('returns 404 when the parent comment is on a different video', async () => {
    store.videos.push({ id: 'video-2', deleted_at: null });
    store.comments.push({
      id: 'c1',
      video_id: 'video-2',
      user_id: 'u1',
      parent_comment_id: null,
      body: 'on another video',
      created_at: '2026-04-30T00:00:01Z',
      updated_at: '2026-04-30T00:00:01Z',
      deleted_at: null,
    });
    const app = buildApp(store, { id: 'u1' });
    const res = await call(app, env, '/api/videos/video-1/comments', {
      method: 'POST',
      body: { body: 'reply', parentCommentId: 'c1' },
    });
    expect(res.status).toBe(404);
  });
});

describe('PATCH /api/comments/:commentId', () => {
  let store: Store;
  let env: CommentsEnv;

  beforeEach(() => {
    store = makeStore({
      comments: [
        {
          id: 'c1',
          video_id: 'video-1',
          user_id: 'u1',
          parent_comment_id: null,
          body: 'original',
          created_at: '2026-04-30T00:00:01Z',
          updated_at: '2026-04-30T00:00:01Z',
          deleted_at: null,
        },
      ],
    });
    env = { DB: fakeDB(store) };
  });

  it('rejects unauthenticated edits', async () => {
    const app = buildApp(store, null);
    const res = await call(app, env, '/api/comments/c1', {
      method: 'PATCH',
      body: { body: 'edited' },
    });
    expect(res.status).toBe(401);
  });

  it('lets the author update their own comment body', async () => {
    const app = buildApp(store, { id: 'u1' });
    const res = await call(app, env, '/api/comments/c1', {
      method: 'PATCH',
      body: { body: 'edited' },
    });
    expect(res.status).toBe(200);
    expect(store.comments[0].body).toBe('edited');
    expect(store.comments[0].updated_at).not.toBe(store.comments[0].created_at);
  });

  it('forbids editing another user’s comment', async () => {
    const app = buildApp(store, { id: 'u2' });
    const res = await call(app, env, '/api/comments/c1', {
      method: 'PATCH',
      body: { body: 'malicious' },
    });
    expect(res.status).toBe(403);
    expect(store.comments[0].body).toBe('original');
  });

  it('returns 404 for a non-existent comment id', async () => {
    const app = buildApp(store, { id: 'u1' });
    const res = await call(app, env, '/api/comments/nope', {
      method: 'PATCH',
      body: { body: 'hi' },
    });
    expect(res.status).toBe(404);
  });

  it('blocks edits that the spam filter rejects', async () => {
    const app = buildApp(store, { id: 'u1' });
    const res = await call(app, env, '/api/comments/c1', {
      method: 'PATCH',
      body: { body: 'AAAAAAAAAAAAAAAAAAAAAAAAAAAAAA' },
    });
    expect(res.status).toBe(422);
    expect(store.comments[0].body).toBe('original');
  });
});

describe('DELETE /api/comments/:commentId', () => {
  let store: Store;
  let env: CommentsEnv;

  beforeEach(() => {
    store = makeStore({
      comments: [
        {
          id: 'c1',
          video_id: 'video-1',
          user_id: 'u1',
          parent_comment_id: null,
          body: 'goodbye',
          created_at: '2026-04-30T00:00:01Z',
          updated_at: '2026-04-30T00:00:01Z',
          deleted_at: null,
        },
      ],
    });
    env = { DB: fakeDB(store) };
  });

  it('rejects unauthenticated deletes', async () => {
    const app = buildApp(store, null);
    const res = await call(app, env, '/api/comments/c1', { method: 'DELETE' });
    expect(res.status).toBe(401);
  });

  it('soft-deletes the author’s own comment and clears the body', async () => {
    const app = buildApp(store, { id: 'u1' });
    const res = await call(app, env, '/api/comments/c1', { method: 'DELETE' });
    expect(res.status).toBe(200);
    expect(store.comments[0].deleted_at).not.toBeNull();
    expect(store.comments[0].body).toBe('');
  });

  it('forbids deleting another user’s comment', async () => {
    const app = buildApp(store, { id: 'u2' });
    const res = await call(app, env, '/api/comments/c1', { method: 'DELETE' });
    expect(res.status).toBe(403);
    expect(store.comments[0].deleted_at).toBeNull();
  });

  it('returns 404 when the comment is already soft-deleted', async () => {
    store.comments[0].deleted_at = '2026-04-30T00:00:99Z';
    const app = buildApp(store, { id: 'u1' });
    const res = await call(app, env, '/api/comments/c1', { method: 'DELETE' });
    expect(res.status).toBe(404);
  });
});
