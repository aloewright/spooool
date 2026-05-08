import { describe, expect, it } from 'vitest';
import { Hono } from 'hono';
import { USERNAME_RE, userRoutes, type UserEnv, type UserVariables } from './users';

describe('USERNAME_RE', () => {
  it('accepts lowercase usernames with allowed characters', () => {
    expect(USERNAME_RE.test('alex')).toBe(true);
    expect(USERNAME_RE.test('alex_99')).toBe(true);
    expect(USERNAME_RE.test('alex-99')).toBe(true);
    expect(USERNAME_RE.test('a1')).toBe(true);
  });

  it('rejects too-short, too-long, or invalid usernames', () => {
    expect(USERNAME_RE.test('a')).toBe(false);
    expect(USERNAME_RE.test('a'.repeat(31))).toBe(false);
    expect(USERNAME_RE.test('Alex')).toBe(false);
    expect(USERNAME_RE.test('alex!')).toBe(false);
    expect(USERNAME_RE.test('-alex')).toBe(false);
    expect(USERNAME_RE.test('_alex')).toBe(false);
    expect(USERNAME_RE.test('')).toBe(false);
  });
});

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

interface FakeStore {
  users: Map<string, UserRow>;
  r2: Map<string, { body: Uint8Array; contentType: string }>;
}

interface Stmt {
  bind(...values: unknown[]): Stmt;
  first<T = unknown>(): Promise<T | null>;
  run(): Promise<{ success: boolean }>;
}

function fakeEnv(store: FakeStore): UserEnv {
  return {
    DB: {
      prepare(sql: string): Stmt {
        let bound: unknown[] = [];
        const trimmed = sql.replace(/\s+/g, ' ').trim();
        const api: Stmt = {
          bind(...v: unknown[]) {
            bound = v;
            return api;
          },
          async first<T>() {
            if (trimmed.startsWith('SELECT id, email, name, username, displayName, bio, avatarUrl, bannerUrl')) {
              const row = store.users.get(bound[0] as string);
              return (row ? { ...row } : null) as T | null;
            }
            if (trimmed.startsWith('SELECT id FROM user WHERE username = ?')) {
              const wantUsername = bound[0] as string;
              const exceptId = bound[1] as string;
              for (const u of store.users.values()) {
                if (u.username === wantUsername && u.id !== exceptId) {
                  return { id: u.id } as T;
                }
              }
              return null;
            }
            return null;
          },
          async run() {
            if (trimmed.startsWith('UPDATE user SET ')) {
              const id = bound[bound.length - 1] as string;
              const row = store.users.get(id);
              if (!row) return { success: false };
              const setPart = trimmed.slice('UPDATE user SET '.length, trimmed.indexOf(' WHERE '));
              const cols = setPart.split(',').map((s) => s.trim().split(' ')[0]);
              cols.forEach((col, i) => {
                (row as unknown as Record<string, unknown>)[col] = bound[i];
              });
              return { success: true };
            }
            return { success: true };
          },
        };
        return api;
      },
    } as unknown as D1Database,
    VIDEOS: {
      async put(
        key: string,
        body: ReadableStream | ArrayBuffer | Uint8Array,
        opts?: { httpMetadata?: { contentType?: string } },
      ) {
        let bytes: Uint8Array;
        if (body instanceof Uint8Array) {
          bytes = body;
        } else if (body instanceof ArrayBuffer) {
          bytes = new Uint8Array(body);
        } else {
          const reader = (body as ReadableStream<Uint8Array>).getReader();
          const chunks: Uint8Array[] = [];
          let total = 0;
          for (;;) {
            const { value, done } = await reader.read();
            if (done) break;
            if (value) {
              chunks.push(value);
              total += value.length;
            }
          }
          bytes = new Uint8Array(total);
          let off = 0;
          for (const c of chunks) {
            bytes.set(c, off);
            off += c.length;
          }
        }
        store.r2.set(key, { body: bytes, contentType: opts?.httpMetadata?.contentType ?? '' });
      },
      async get(key: string) {
        const v = store.r2.get(key);
        if (!v) return null;
        return {
          body: new Blob([v.body]).stream(),
          httpMetadata: { contentType: v.contentType },
        };
      },
    } as unknown as R2Bucket,
  };
}

function makeApp(store: FakeStore, user: { id: string; email: string; name: string } | null) {
  const app = new Hono<{ Bindings: UserEnv; Variables: UserVariables }>();
  app.use('*', async (c, next) => {
    c.set('user', user);
    await next();
  });
  app.route('/', userRoutes);
  const env = fakeEnv(store);
  return {
    request(url: string, init?: RequestInit): Promise<Response> {
      return app.request(url, init, env) as Promise<Response>;
    },
  };
}

function seed(): FakeStore {
  return {
    users: new Map([
      [
        'u1',
        {
          id: 'u1',
          email: 'a@b.com',
          name: 'Alice',
          username: null,
          displayName: null,
          bio: null,
          avatarUrl: null,
          bannerUrl: null,
        },
      ],
      [
        'u2',
        {
          id: 'u2',
          email: 'b@b.com',
          name: 'Bob',
          username: 'bob',
          displayName: null,
          bio: null,
          avatarUrl: null,
          bannerUrl: null,
        },
      ],
    ]),
    r2: new Map(),
  };
}

describe('GET /api/users/me', () => {
  it('returns 401 when unauthenticated', async () => {
    const store = seed();
    const app = makeApp(store, null);
    const res = await app.request('http://x/api/users/me');
    expect(res.status).toBe(401);
  });

  it('returns the profile for the current user', async () => {
    const store = seed();
    const app = makeApp(store, { id: 'u1', email: 'a@b.com', name: 'Alice' });
    const res = await app.request('http://x/api/users/me');
    expect(res.status).toBe(200);
    const body = (await res.json()) as { id: string; email: string };
    expect(body.id).toBe('u1');
    expect(body.email).toBe('a@b.com');
  });
});

describe('PUT /api/users/me', () => {
  it('rejects invalid username format', async () => {
    const store = seed();
    const app = makeApp(store, { id: 'u1', email: 'a@b.com', name: 'Alice' });
    const res = await app.request('http://x/api/users/me', {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ username: 'BadName!' }),
    });
    expect(res.status).toBe(400);
  });

  it('rejects bio over 500 chars', async () => {
    const store = seed();
    const app = makeApp(store, { id: 'u1', email: 'a@b.com', name: 'Alice' });
    const res = await app.request('http://x/api/users/me', {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ bio: 'a'.repeat(501) }),
    });
    expect(res.status).toBe(400);
  });

  it('rejects username already taken by another user', async () => {
    const store = seed();
    const app = makeApp(store, { id: 'u1', email: 'a@b.com', name: 'Alice' });
    const res = await app.request('http://x/api/users/me', {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ username: 'bob' }),
    });
    expect(res.status).toBe(409);
  });

  it('saves valid display name and bio', async () => {
    const store = seed();
    const app = makeApp(store, { id: 'u1', email: 'a@b.com', name: 'Alice' });
    const res = await app.request('http://x/api/users/me', {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ displayName: 'Alice W', bio: 'Hi there' }),
    });
    expect(res.status).toBe(200);
    const row = store.users.get('u1');
    expect(row?.displayName).toBe('Alice W');
    expect(row?.bio).toBe('Hi there');
  });
});

describe('POST /api/users/me/avatar', () => {
  it('rejects unsupported MIME', async () => {
    const store = seed();
    const app = makeApp(store, { id: 'u1', email: 'a@b.com', name: 'Alice' });
    const fd = new FormData();
    fd.set('file', new File(['x'], 'a.gif', { type: 'image/gif' }));
    const res = await app.request('http://x/api/users/me/avatar', { method: 'POST', body: fd });
    expect(res.status).toBe(400);
  });

  it('rejects file over 2MB', async () => {
    const store = seed();
    const app = makeApp(store, { id: 'u1', email: 'a@b.com', name: 'Alice' });
    const fd = new FormData();
    fd.set('file', new File([new Uint8Array(2 * 1024 * 1024 + 1)], 'a.png', { type: 'image/png' }));
    const res = await app.request('http://x/api/users/me/avatar', { method: 'POST', body: fd });
    expect(res.status).toBe(400);
  });

  it('uploads valid PNG and updates avatarUrl', async () => {
    const store = seed();
    const app = makeApp(store, { id: 'u1', email: 'a@b.com', name: 'Alice' });
    const fd = new FormData();
    fd.set('file', new File([new Uint8Array(16)], 'a.png', { type: 'image/png' }));
    const res = await app.request('http://x/api/users/me/avatar', { method: 'POST', body: fd });
    expect(res.status).toBe(201);
    const body = (await res.json()) as { url: string };
    expect(body.url).toMatch(/\/api\/users\/avatars\/u1\/[0-9a-f-]+\.png$/);
    expect(store.users.get('u1')?.avatarUrl).toBe(body.url);
    expect(store.r2.size).toBe(1);
  });

  it('returns 401 unauthenticated', async () => {
    const store = seed();
    const app = makeApp(store, null);
    const fd = new FormData();
    fd.set('file', new File([new Uint8Array(8)], 'a.png', { type: 'image/png' }));
    const res = await app.request('http://x/api/users/me/avatar', { method: 'POST', body: fd });
    expect(res.status).toBe(401);
  });
});

describe('GET /api/users/avatars/:userId/:objectName', () => {
  it('rejects unsafe object names', async () => {
    const store = seed();
    const app = makeApp(store, null);
    const res = await app.request('http://x/api/users/avatars/u1/..%2Fevil');
    expect(res.status).toBe(400);
  });

  it('returns 404 when object missing', async () => {
    const store = seed();
    const app = makeApp(store, null);
    const res = await app.request('http://x/api/users/avatars/u1/nope.png');
    expect(res.status).toBe(404);
  });

  it('serves stored R2 image with cache-control', async () => {
    const store = seed();
    store.r2.set('avatars/u1/pic.png', {
      body: new Uint8Array([1, 2, 3]),
      contentType: 'image/png',
    });
    const app = makeApp(store, null);
    const res = await app.request('http://x/api/users/avatars/u1/pic.png');
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toBe('image/png');
    expect(res.headers.get('cache-control')).toContain('immutable');
  });
});
