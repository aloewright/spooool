import { Hono } from 'hono';
import { beforeEach, describe, expect, it } from 'vitest';
import { userRoutes, type UserEnv, type UserVariables } from './users';

interface UserRow {
  id: string;
  email: string;
  name: string;
  username: string | null;
  displayName: string | null;
  bio: string | null;
  avatarUrl: string | null;
  bannerUrl: string | null;
  updatedAt: number;
}

interface Store {
  users: UserRow[];
}

function makeStore(initial?: Partial<Store>): Store {
  return {
    users: initial?.users ?? [
      {
        id: 'u1',
        email: 'alice@example.com',
        name: 'Alice',
        username: 'alice',
        displayName: 'Alice A',
        bio: 'hello',
        avatarUrl: null,
        bannerUrl: null,
        updatedAt: 0,
      },
    ],
  };
}

interface PreparedStmt {
  bind(...values: unknown[]): PreparedStmt;
  first<T = unknown>(): Promise<T | null>;
  run(): Promise<{ success: boolean }>;
  all<T = unknown>(): Promise<{ results: T[] }>;
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
        if (q.startsWith('SELECT id, email, name, username, displayName, bio, avatarUrl, bannerUrl FROM user WHERE id = ?')) {
          const [id] = args as [string];
          const u = store.users.find((x) => x.id === id);
          if (!u) return null;
          const { updatedAt: _u, ...rest } = u;
          return rest as unknown as T;
        }
        if (q.startsWith('SELECT id FROM user WHERE username = ? AND id != ?')) {
          const [username, notId] = args as [string, string];
          const u = store.users.find((x) => x.username === username && x.id !== notId);
          return (u ? ({ id: u.id } as unknown as T) : null);
        }
        throw new Error(`unexpected first query: ${q}`);
      },
      async run() {
        if (q.startsWith('UPDATE user SET')) {
          const setPart = q.slice('UPDATE user SET '.length, q.indexOf(' WHERE'));
          const cols = setPart.split(',').map((s) => s.trim().split(' ')[0]);
          const id = args[args.length - 1] as string;
          const values = args.slice(0, -1);
          const u = store.users.find((x) => x.id === id);
          if (u) {
            cols.forEach((col, i) => {
              const v = values[i];
              // map snake-ish col names to row keys verbatim
              (u as unknown as Record<string, unknown>)[col] = v;
            });
          }
          return { success: true };
        }
        throw new Error(`unexpected run query: ${q}`);
      },
      async all<_T>() {
        throw new Error(`unexpected all query: ${q}`);
      },
    };
    return stmt;
  }
  return { prepare } as unknown as D1Database;
}

interface R2Object {
  body: ReadableStream | Uint8Array;
  httpMetadata?: { contentType?: string };
}

function fakeR2(): { binding: R2Bucket; storage: Map<string, { bytes: Uint8Array; contentType?: string }> } {
  const storage = new Map<string, { bytes: Uint8Array; contentType?: string }>();
  const binding = {
    async put(
      key: string,
      stream: ReadableStream | ArrayBuffer | Uint8Array,
      opts?: { httpMetadata?: { contentType?: string } },
    ) {
      let bytes: Uint8Array;
      if (stream instanceof ReadableStream) {
        const reader = stream.getReader();
        const chunks: Uint8Array[] = [];
        let total = 0;
        // eslint-disable-next-line no-constant-condition
        while (true) {
          const { value, done } = await reader.read();
          if (done) break;
          if (value) {
            chunks.push(value);
            total += value.byteLength;
          }
        }
        bytes = new Uint8Array(total);
        let offset = 0;
        for (const c of chunks) {
          bytes.set(c, offset);
          offset += c.byteLength;
        }
      } else if (stream instanceof Uint8Array) {
        bytes = stream;
      } else {
        bytes = new Uint8Array(stream);
      }
      storage.set(key, { bytes, contentType: opts?.httpMetadata?.contentType });
    },
    async get(key: string): Promise<R2Object | null> {
      const obj = storage.get(key);
      if (!obj) return null;
      return {
        body: obj.bytes,
        httpMetadata: { contentType: obj.contentType },
      };
    },
  } as unknown as R2Bucket;
  return { binding, storage };
}

function buildApp(user: { id: string; email: string; name: string } | null) {
  const app = new Hono<{ Bindings: UserEnv; Variables: UserVariables }>();
  app.use('*', async (c, next) => {
    c.set('user', user);
    await next();
  });
  app.route('/', userRoutes);
  return app;
}

describe('userRoutes integration', () => {
  let store: Store;
  let r2: ReturnType<typeof fakeR2>;
  let env: UserEnv;

  beforeEach(() => {
    store = makeStore();
    r2 = fakeR2();
    env = { DB: fakeDB(store), VIDEOS: r2.binding };
  });

  describe('GET /api/users/me', () => {
    it('returns 401 without a session', async () => {
      const app = buildApp(null);
      const res = await app.request('/api/users/me', {}, env);
      expect(res.status).toBe(401);
    });

    it('returns the profile for the signed-in user', async () => {
      const app = buildApp({ id: 'u1', email: 'alice@example.com', name: 'Alice' });
      const res = await app.request('/api/users/me', {}, env);
      expect(res.status).toBe(200);
      const body = (await res.json()) as { id: string; username: string };
      expect(body.id).toBe('u1');
      expect(body.username).toBe('alice');
    });

    it('returns 404 if the session user no longer exists', async () => {
      const app = buildApp({ id: 'ghost', email: 'g@x', name: 'g' });
      const res = await app.request('/api/users/me', {}, env);
      expect(res.status).toBe(404);
    });
  });

  describe('PUT /api/users/me', () => {
    it('rejects invalid usernames with 400', async () => {
      const app = buildApp({ id: 'u1', email: 'alice@example.com', name: 'Alice' });
      const res = await app.request(
        '/api/users/me',
        {
          method: 'PUT',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ username: 'BadName!' }),
        },
        env,
      );
      expect(res.status).toBe(400);
    });

    it('returns 409 when the username is taken by another user', async () => {
      store.users.push({
        id: 'u2',
        email: 'b@x',
        name: 'B',
        username: 'taken',
        displayName: null,
        bio: null,
        avatarUrl: null,
        bannerUrl: null,
        updatedAt: 0,
      });
      const app = buildApp({ id: 'u1', email: 'alice@example.com', name: 'Alice' });
      const res = await app.request(
        '/api/users/me',
        {
          method: 'PUT',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ username: 'taken' }),
        },
        env,
      );
      expect(res.status).toBe(409);
    });

    it('updates displayName and bio and returns the refreshed row', async () => {
      const app = buildApp({ id: 'u1', email: 'alice@example.com', name: 'Alice' });
      const res = await app.request(
        '/api/users/me',
        {
          method: 'PUT',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ displayName: 'New Name', bio: 'updated bio' }),
        },
        env,
      );
      expect(res.status).toBe(200);
      const body = (await res.json()) as { displayName: string; bio: string };
      expect(body.displayName).toBe('New Name');
      expect(body.bio).toBe('updated bio');
      expect(store.users[0].displayName).toBe('New Name');
    });

    it('returns 400 with an empty patch', async () => {
      const app = buildApp({ id: 'u1', email: 'alice@example.com', name: 'Alice' });
      const res = await app.request(
        '/api/users/me',
        {
          method: 'PUT',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({}),
        },
        env,
      );
      expect(res.status).toBe(400);
    });
  });

  describe('avatar + banner upload', () => {
    function makeForm(filename: string, type: string, size = 16): FormData {
      const form = new FormData();
      form.set('file', new File([new Uint8Array(size)], filename, { type }));
      return form;
    }

    it('uploads an avatar, persists URL, and serves the bytes from R2', async () => {
      const app = buildApp({ id: 'u1', email: 'alice@example.com', name: 'Alice' });
      const upload = await app.request(
        'http://example.com/api/users/me/avatar',
        { method: 'POST', body: makeForm('a.png', 'image/png') },
        env,
      );
      expect(upload.status).toBe(201);
      const { url } = (await upload.json()) as { url: string };
      const path = new URL(url).pathname;
      expect(path).toMatch(/^\/api\/users\/avatars\/u1\/[0-9a-f-]+\.png$/);
      expect(store.users[0].avatarUrl).toBe(url);
      expect(r2.storage.size).toBe(1);

      const serve = await app.request(`http://example.com${path}`, {}, env);
      expect(serve.status).toBe(200);
      expect(serve.headers.get('content-type')).toBe('image/png');
      expect(serve.headers.get('cache-control')).toContain('immutable');
    });

    it('rejects unsupported mime types with 400', async () => {
      const app = buildApp({ id: 'u1', email: 'alice@example.com', name: 'Alice' });
      const res = await app.request(
        'http://example.com/api/users/me/avatar',
        { method: 'POST', body: makeForm('a.gif', 'image/gif') },
        env,
      );
      expect(res.status).toBe(400);
    });

    it('rejects oversize avatars with 400', async () => {
      const app = buildApp({ id: 'u1', email: 'alice@example.com', name: 'Alice' });
      const big = 2 * 1024 * 1024 + 1;
      const res = await app.request(
        'http://example.com/api/users/me/avatar',
        { method: 'POST', body: makeForm('a.png', 'image/png', big) },
        env,
      );
      expect(res.status).toBe(400);
    });

    it('uploads a banner under banners/ prefix', async () => {
      const app = buildApp({ id: 'u1', email: 'alice@example.com', name: 'Alice' });
      const res = await app.request(
        'http://example.com/api/users/me/banner',
        { method: 'POST', body: makeForm('b.webp', 'image/webp') },
        env,
      );
      expect(res.status).toBe(201);
      const { url } = (await res.json()) as { url: string };
      expect(new URL(url).pathname.startsWith('/api/users/banners/u1/')).toBe(true);
      expect(store.users[0].bannerUrl).toBe(url);
      const r2Key = [...r2.storage.keys()][0];
      expect(r2Key.startsWith('banners/u1/')).toBe(true);
    });

    it('requires a session for upload endpoints', async () => {
      const app = buildApp(null);
      const res = await app.request(
        'http://example.com/api/users/me/avatar',
        { method: 'POST', body: makeForm('a.png', 'image/png') },
        env,
      );
      expect(res.status).toBe(401);
    });
  });

  describe('serve image traversal protection', () => {
    it('rejects object names with disallowed chars', async () => {
      const app = buildApp(null);
      const res = await app.request(
        'http://example.com/api/users/avatars/u1/..%2Fevil',
        {},
        env,
      );
      expect(res.status).toBe(400);
    });

    it('returns 404 when the R2 object is missing', async () => {
      const app = buildApp(null);
      const res = await app.request(
        'http://example.com/api/users/avatars/u1/missing.png',
        {},
        env,
      );
      expect(res.status).toBe(404);
    });
  });
});
