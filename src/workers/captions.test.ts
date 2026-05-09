import { Hono } from 'hono';
import { describe, expect, it } from 'vitest';
import {
  captionR2Key,
  captionsRoutes,
  isValidWebVtt,
  normalizeLanguage,
  type CaptionsEnv,
} from './captions';

const VALID_VTT = 'WEBVTT\n\n00:00:00.000 --> 00:00:02.000\nHello world\n';

interface FakeStmt {
  bind: (...values: unknown[]) => FakeStmt;
  first: <T>() => Promise<T | null>;
  run: () => Promise<{ success: boolean }>;
  all: <T>() => Promise<{ results: T[] }>;
}

interface FakeDBSpec {
  videoOwner?: string | null;
  videoExists?: boolean;
  captionRow?: { user_id: string; deleted_at: string | null; r2_key: string } | null;
  existingCaptionR2Key?: string | null;
  captionRows?: unknown[];
}

interface FakeDBResult {
  db: D1Database;
  prepares: string[];
  binds: unknown[][];
}

function fakeDB(spec: FakeDBSpec): FakeDBResult {
  const prepares: string[] = [];
  const binds: unknown[][] = [];
  const prepare = (sql: string): FakeStmt => {
    prepares.push(sql);
    let lastBind: unknown[] = [];
    const stmt: FakeStmt = {
      bind: (...values) => {
        lastBind = values;
        binds.push(values);
        return stmt;
      },
      first: async () => {
        if (sql.includes('FROM video_captions') && sql.includes('JOIN videos')) {
          return (spec.captionRow ?? null) as never;
        }
        if (sql.includes('FROM video_captions') && sql.includes('SELECT r2_key')) {
          return spec.existingCaptionR2Key
            ? ({ r2_key: spec.existingCaptionR2Key } as never)
            : null;
        }
        if (sql.includes('SELECT user_id FROM videos')) {
          return spec.videoOwner === undefined
            ? null
            : spec.videoOwner === null
              ? null
              : ({ user_id: spec.videoOwner } as never);
        }
        if (sql.includes('SELECT 1 FROM videos')) {
          return spec.videoExists ? ({ '1': 1 } as never) : null;
        }
        return null;
      },
      run: async () => ({ success: true }),
      all: async () => ({ results: (spec.captionRows ?? []) as never[] }),
    };
    void lastBind;
    return stmt;
  };
  return {
    db: { prepare } as unknown as D1Database,
    prepares,
    binds,
  };
}

interface FakeR2 {
  bucket: R2Bucket;
  puts: Array<{ key: string; body: string }>;
  deletes: string[];
  objects: Map<string, string>;
}

function fakeR2(seed: Record<string, string> = {}): FakeR2 {
  const objects = new Map<string, string>(Object.entries(seed));
  const puts: Array<{ key: string; body: string }> = [];
  const deletes: string[] = [];
  const bucket = {
    head: async (key: string) => {
      const v = objects.get(key);
      if (v == null) return null;
      return { size: new TextEncoder().encode(v).byteLength };
    },
    get: async (key: string) => {
      const v = objects.get(key);
      if (v == null) return null;
      return { body: v };
    },
    put: async (key: string, body: string | ArrayBuffer | ReadableStream) => {
      const text = typeof body === 'string' ? body : '';
      objects.set(key, text);
      puts.push({ key, body: text });
      return { etag: 'fake' };
    },
    delete: async (key: string) => {
      objects.delete(key);
      deletes.push(key);
    },
  } as unknown as R2Bucket;
  return { bucket, puts, deletes, objects };
}

type SessionUser = { id: string } | null;

function buildApp(user: SessionUser) {
  const app = new Hono<{ Bindings: CaptionsEnv; Variables: { user: SessionUser } }>();
  app.use('*', async (c, next) => {
    c.set('user', user);
    await next();
  });
  app.route('/', captionsRoutes);
  return app;
}

describe('captionR2Key', () => {
  it('namespaces by user, video, language', () => {
    expect(captionR2Key('u1', 'v1', 'en')).toBe('u1/v1/captions/en.vtt');
  });
});

describe('normalizeLanguage', () => {
  it('lowercases simple BCP-47 tags', () => {
    expect(normalizeLanguage('EN')).toBe('en');
    expect(normalizeLanguage('en-US')).toBe('en-us');
    expect(normalizeLanguage('zh-Hans')).toBe('zh-hans');
  });
  it('rejects empty / numeric / out-of-range tags', () => {
    expect(normalizeLanguage('')).toBeNull();
    expect(normalizeLanguage('1234')).toBeNull();
    expect(normalizeLanguage('a')).toBeNull();
    expect(normalizeLanguage('toolongtag')).toBeNull();
  });
});

describe('isValidWebVtt', () => {
  it('accepts the canonical WEBVTT preamble', () => {
    expect(isValidWebVtt('WEBVTT\n\n00:00:00.000 --> 00:00:01.000\nhi\n')).toBe(true);
  });
  it('accepts WEBVTT with header comment', () => {
    expect(isValidWebVtt('WEBVTT - From clip\n\n00:00:00.000 --> 00:00:01.000\nhi\n')).toBe(true);
  });
  it('accepts UTF-8 BOM-prefixed WEBVTT', () => {
    expect(isValidWebVtt('﻿WEBVTT\n\n00:00:00.000 --> 00:00:01.000\nhi\n')).toBe(true);
  });
  it('rejects bodies that don\'t start with WEBVTT', () => {
    expect(isValidWebVtt('not a vtt file')).toBe(false);
    expect(isValidWebVtt('webvtt\n')).toBe(false);
    expect(isValidWebVtt('')).toBe(false);
  });
});

describe('GET /api/videos/:id/captions', () => {
  it('404s when the video does not exist', async () => {
    const { db } = fakeDB({ videoExists: false });
    const { bucket } = fakeR2();
    const res = await buildApp(null).request(
      '/api/videos/v1/captions',
      {},
      { DB: db, VIDEOS: bucket },
    );
    expect(res.status).toBe(404);
  });

  it('returns the list of caption tracks with computed src URLs', async () => {
    const { db } = fakeDB({
      videoExists: true,
      captionRows: [
        {
          language: 'en',
          label: 'English',
          is_default: 1,
          bytes: 256,
          updated_at: '2026-05-09 00:00:00',
        },
        {
          language: 'es',
          label: 'Español',
          is_default: 0,
          bytes: 200,
          updated_at: '2026-05-09 00:00:00',
        },
      ],
    });
    const { bucket } = fakeR2();
    const res = await buildApp(null).request(
      '/api/videos/v1/captions',
      {},
      { DB: db, VIDEOS: bucket },
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as { tracks: Array<Record<string, unknown>> };
    expect(body.tracks.length).toBe(2);
    expect(body.tracks[0]).toMatchObject({
      language: 'en',
      label: 'English',
      isDefault: true,
      bytes: 256,
      src: '/api/videos/v1/captions/en.vtt',
    });
    expect(body.tracks[1]?.isDefault).toBe(false);
  });
});

describe('GET /api/videos/:id/captions/:lang.vtt', () => {
  it('400s on an invalid language tag', async () => {
    const { db } = fakeDB({});
    const { bucket } = fakeR2();
    const res = await buildApp(null).request(
      '/api/videos/v1/captions/1234.vtt',
      {},
      { DB: db, VIDEOS: bucket },
    );
    expect(res.status).toBe(400);
  });

  it('404s when the file does not end in .vtt', async () => {
    const { db } = fakeDB({});
    const { bucket } = fakeR2();
    const res = await buildApp(null).request(
      '/api/videos/v1/captions/en',
      {},
      { DB: db, VIDEOS: bucket },
    );
    expect(res.status).toBe(404);
  });

  it('404s when the row does not exist', async () => {
    const { db } = fakeDB({ captionRow: null });
    const { bucket } = fakeR2();
    const res = await buildApp(null).request(
      '/api/videos/v1/captions/en.vtt',
      {},
      { DB: db, VIDEOS: bucket },
    );
    expect(res.status).toBe(404);
  });

  it('serves the VTT body with the correct content type', async () => {
    const r2Key = 'u1/v1/captions/en.vtt';
    const { db } = fakeDB({
      captionRow: { user_id: 'u1', deleted_at: null, r2_key: r2Key },
    });
    const { bucket } = fakeR2({ [r2Key]: VALID_VTT });
    const res = await buildApp(null).request(
      '/api/videos/v1/captions/en.vtt',
      {},
      { DB: db, VIDEOS: bucket },
    );
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toBe('text/vtt; charset=utf-8');
    expect(await res.text()).toBe(VALID_VTT);
  });

  it('refuses to serve captions belonging to a soft-deleted video', async () => {
    const r2Key = 'u1/v1/captions/en.vtt';
    const { db } = fakeDB({
      captionRow: { user_id: 'u1', deleted_at: '2026-05-09 00:00:00', r2_key: r2Key },
    });
    const { bucket } = fakeR2({ [r2Key]: VALID_VTT });
    const res = await buildApp(null).request(
      '/api/videos/v1/captions/en.vtt',
      {},
      { DB: db, VIDEOS: bucket },
    );
    expect(res.status).toBe(404);
  });
});

describe('PUT /api/videos/:id/captions/:lang', () => {
  it('401s without a session', async () => {
    const { db } = fakeDB({});
    const { bucket } = fakeR2();
    const res = await buildApp(null).request(
      '/api/videos/v1/captions/en',
      {
        method: 'PUT',
        headers: { 'x-caption-label': 'English', 'content-type': 'text/vtt' },
        body: VALID_VTT,
      },
      { DB: db, VIDEOS: bucket },
    );
    expect(res.status).toBe(401);
  });

  it('400s on an invalid language tag', async () => {
    const { db } = fakeDB({});
    const { bucket } = fakeR2();
    const res = await buildApp({ id: 'u1' }).request(
      '/api/videos/v1/captions/1234',
      {
        method: 'PUT',
        headers: { 'x-caption-label': 'English' },
        body: VALID_VTT,
      },
      { DB: db, VIDEOS: bucket },
    );
    expect(res.status).toBe(400);
  });

  it('404s when the video does not exist', async () => {
    const { db } = fakeDB({ videoOwner: null });
    const { bucket } = fakeR2();
    const res = await buildApp({ id: 'u1' }).request(
      '/api/videos/v1/captions/en',
      {
        method: 'PUT',
        headers: { 'x-caption-label': 'English' },
        body: VALID_VTT,
      },
      { DB: db, VIDEOS: bucket },
    );
    expect(res.status).toBe(404);
  });

  it('403s when the caller is not the video owner', async () => {
    const { db } = fakeDB({ videoOwner: 'someone-else' });
    const { bucket } = fakeR2();
    const res = await buildApp({ id: 'u1' }).request(
      '/api/videos/v1/captions/en',
      {
        method: 'PUT',
        headers: { 'x-caption-label': 'English' },
        body: VALID_VTT,
      },
      { DB: db, VIDEOS: bucket },
    );
    expect(res.status).toBe(403);
  });

  it('400s when the body is missing the WEBVTT header', async () => {
    const { db } = fakeDB({ videoOwner: 'u1' });
    const { bucket } = fakeR2();
    const res = await buildApp({ id: 'u1' }).request(
      '/api/videos/v1/captions/en',
      {
        method: 'PUT',
        headers: { 'x-caption-label': 'English' },
        body: 'this is plain text not vtt',
      },
      { DB: db, VIDEOS: bucket },
    );
    expect(res.status).toBe(400);
    const body = (await res.json()) as { code?: string };
    expect(body.code).toBe('invalid_webvtt');
  });

  it('400s on missing label header', async () => {
    const { db } = fakeDB({ videoOwner: 'u1' });
    const { bucket } = fakeR2();
    const res = await buildApp({ id: 'u1' }).request(
      '/api/videos/v1/captions/en',
      {
        method: 'PUT',
        body: VALID_VTT,
      },
      { DB: db, VIDEOS: bucket },
    );
    expect(res.status).toBe(400);
  });

  it('writes to R2 and inserts a row on a fresh upload', async () => {
    const { db, prepares } = fakeDB({ videoOwner: 'u1' });
    const { bucket, puts } = fakeR2();
    const res = await buildApp({ id: 'u1' }).request(
      '/api/videos/v1/captions/EN',
      {
        method: 'PUT',
        headers: { 'x-caption-label': 'English', 'x-caption-default': '1' },
        body: VALID_VTT,
      },
      { DB: db, VIDEOS: bucket },
    );
    expect(res.status).toBe(200);
    expect(puts.length).toBe(1);
    expect(puts[0]?.key).toBe('u1/v1/captions/en.vtt');
    expect(puts[0]?.body).toBe(VALID_VTT);
    // First prepare loads owner; second clears other defaults; third upserts.
    expect(prepares.some((sql) => /UPDATE video_captions SET is_default = 0/.test(sql))).toBe(true);
    expect(prepares.some((sql) => /INSERT INTO video_captions/.test(sql))).toBe(true);
    const body = (await res.json()) as { language: string; isDefault: boolean };
    expect(body.language).toBe('en');
    expect(body.isDefault).toBe(true);
  });

  it('413s when the body exceeds MAX_VTT_BYTES', async () => {
    const { db } = fakeDB({ videoOwner: 'u1' });
    const { bucket } = fakeR2();
    const oversized = 'WEBVTT\n\n' + 'a'.repeat(2 * 1024 * 1024 + 16);
    const res = await buildApp({ id: 'u1' }).request(
      '/api/videos/v1/captions/en',
      {
        method: 'PUT',
        headers: { 'x-caption-label': 'English' },
        body: oversized,
      },
      { DB: db, VIDEOS: bucket },
    );
    expect(res.status).toBe(413);
    const body = (await res.json()) as { code?: string };
    expect(body.code).toBe('caption_too_large');
  });
});

describe('DELETE /api/videos/:id/captions/:lang', () => {
  it('401s without a session', async () => {
    const { db } = fakeDB({});
    const { bucket } = fakeR2();
    const res = await buildApp(null).request(
      '/api/videos/v1/captions/en',
      { method: 'DELETE' },
      { DB: db, VIDEOS: bucket },
    );
    expect(res.status).toBe(401);
  });

  it('403s when the caller is not the owner', async () => {
    const { db } = fakeDB({ videoOwner: 'other' });
    const { bucket } = fakeR2();
    const res = await buildApp({ id: 'u1' }).request(
      '/api/videos/v1/captions/en',
      { method: 'DELETE' },
      { DB: db, VIDEOS: bucket },
    );
    expect(res.status).toBe(403);
  });

  it('204s and removes the R2 object on a successful delete', async () => {
    const r2Key = 'u1/v1/captions/en.vtt';
    const { db } = fakeDB({ videoOwner: 'u1', existingCaptionR2Key: r2Key });
    const { bucket, deletes } = fakeR2({ [r2Key]: VALID_VTT });
    const res = await buildApp({ id: 'u1' }).request(
      '/api/videos/v1/captions/en',
      { method: 'DELETE' },
      { DB: db, VIDEOS: bucket },
    );
    expect(res.status).toBe(204);
    expect(deletes).toEqual([r2Key]);
  });

  it('204s idempotently when there is no row to delete', async () => {
    const { db } = fakeDB({ videoOwner: 'u1', existingCaptionR2Key: null });
    const { bucket, deletes } = fakeR2();
    const res = await buildApp({ id: 'u1' }).request(
      '/api/videos/v1/captions/en',
      { method: 'DELETE' },
      { DB: db, VIDEOS: bucket },
    );
    expect(res.status).toBe(204);
    expect(deletes).toEqual([]);
  });
});
