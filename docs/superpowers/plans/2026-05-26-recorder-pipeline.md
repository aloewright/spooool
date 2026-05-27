# Recorder + Render Pipeline Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Ship sub-project #1 from the design spec: an in-app `/record` page that captures webcam + screen, allows multi-take, and renders a final video via Remotion in a per-account Cloudflare Container before handing off to the existing Cloudflare Stream pipeline.

**Architecture:** Three new pieces (frontend recorder UI ported from `remotion-dev/recorder`, new Hono routes in the existing Worker, and a new Cloudflare Container that runs `@remotion/renderer`). Composition is deterministic (fixed templates, parameterized title/brand) — AI-driven composition is sub-project #2 and out of scope here. See `docs/superpowers/specs/2026-05-26-recorder-pipeline-design.md` for the full spec.

**Tech Stack:** Hono on Cloudflare Workers, Cloudflare D1 + R2 + Queues + Containers + Stream, React 18 + Vite + React Router, Remotion 4 (`@remotion/renderer`, `@remotion/player`), WebCodecs API, `vitest` for unit tests, `@playwright/test` for E2E.

**Source-of-truth references:**
- Design spec: `docs/superpowers/specs/2026-05-26-recorder-pipeline-design.md`
- Recorder repo to port from: `https://github.com/remotion-dev/recorder` (commit `main`)
- CF Containers reference: `https://developers.cloudflare.com/containers/`
- Existing chunked-upload to mirror: `src/frontend/pages/Upload.tsx:28-90`
- Existing worker route pattern: `src/workers/lifecycle.ts`
- Existing migration pattern: `src/db/migrations/0014_admin_roles.sql`
- Existing cron handler entry: `src/workers/index.ts` (the `scheduled` export)

---

## Phase A — Database

### Task 1: `render_jobs` table migration

**Files:**
- Create: `src/db/migrations/0020_render_jobs.sql`

- [ ] **Step 1: Write the migration**

```sql
-- Sub-project #1 of recorder + render pipeline. Tracks the lifecycle of a
-- single video render job triggered from /record: queued → rendering →
-- completed | failed. The composition_spec JSON column holds the user's
-- chosen scenes / layouts / title / brand props verbatim so the container
-- can re-run with the same inputs without re-deriving from D1 rows.
--
-- Cleanup of stuck jobs (`status='rendering'` past timeout) is handled by
-- the cron sweep in src/workers/render.ts. The idx_render_jobs_stuck index
-- exists to make that sweep cheap (it scans by status + updated_at).

CREATE TABLE IF NOT EXISTS render_jobs (
  id TEXT PRIMARY KEY NOT NULL,
  user_id TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('queued','rendering','completed','failed')),
  progress INTEGER NOT NULL DEFAULT 0,
  composition_spec TEXT NOT NULL,
  output_r2_key TEXT,
  video_id TEXT,
  error_message TEXT,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_render_jobs_user_status ON render_jobs(user_id, status);
CREATE INDEX IF NOT EXISTS idx_render_jobs_stuck ON render_jobs(status, updated_at);
```

- [ ] **Step 2: Apply to local D1 to sanity-check**

```bash
npx wrangler d1 migrations apply spooool-prod --local
```

Expected: "Migrations applied" with `0020_render_jobs.sql` in the list. If it errors, the SQL is wrong — fix and re-run.

- [ ] **Step 3: Commit**

```bash
git add src/db/migrations/0020_render_jobs.sql
git commit -m "feat(db): add render_jobs table for recorder pipeline"
```

---

## Phase B — Shared chunked-upload helper

### Task 2: Extract chunked upload into a reusable module

**Files:**
- Create: `src/frontend/lib/chunked-upload.ts`
- Create: `src/frontend/lib/chunked-upload.test.ts`
- Modify: `src/frontend/pages/Upload.tsx` (remove inlined `uploadInChunks`, import the new module)

- [ ] **Step 1: Write the failing test**

```ts
// src/frontend/lib/chunked-upload.test.ts
import { describe, expect, it, vi, afterEach } from 'vitest';
import { uploadInChunks, type UploadTarget } from './chunked-upload';

const originalFetch = globalThis.fetch;
afterEach(() => { globalThis.fetch = originalFetch; });

function mockFetch(impl: (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>) {
  globalThis.fetch = vi.fn(impl) as unknown as typeof fetch;
}

function makeFile(bytes: number, name = 'clip.webm', type = 'video/webm'): File {
  return new File([new Uint8Array(bytes)], name, { type });
}

describe('uploadInChunks', () => {
  it('posts every chunk to the configured endpoint and threads uploadId across calls', async () => {
    const calls: Array<{ formChunkIndex: string; uploadId: string | null }> = [];
    mockFetch(async (_url, init) => {
      const fd = init?.body as FormData;
      const idx = fd.get('chunkIndex') as string;
      calls.push({ formChunkIndex: idx, uploadId: (fd.get('uploadId') as string) ?? null });
      return new Response(JSON.stringify({ uploadId: 'u_1' }), { status: 200 });
    });
    const file = makeFile(25 * 1024 * 1024); // 3 chunks at 10MB each
    const res = await uploadInChunks({
      file,
      endpoint: '/api/videos/upload',
      target: 'video' as UploadTarget,
      fields: { title: 'hi', description: '' },
      onProgress: () => {},
    });
    expect(res.ok).toBe(true);
    expect(calls).toHaveLength(3);
    expect(calls[0].uploadId).toBeNull();
    expect(calls[1].uploadId).toBe('u_1');
    expect(calls[2].uploadId).toBe('u_1');
  });

  it('reports monotonic progress 0..1 across all chunks', async () => {
    mockFetch(async () => new Response(JSON.stringify({ uploadId: 'u' }), { status: 200 }));
    const file = makeFile(20 * 1024 * 1024);
    const seen: number[] = [];
    await uploadInChunks({
      file,
      endpoint: '/api/videos/upload',
      target: 'video',
      fields: {},
      onProgress: (v) => seen.push(v),
    });
    expect(seen[seen.length - 1]).toBe(1);
    for (let i = 1; i < seen.length; i++) expect(seen[i]).toBeGreaterThanOrEqual(seen[i - 1]);
  });

  it('throws when a chunk POST returns non-2xx', async () => {
    mockFetch(async () => new Response('{"error":"oops"}', { status: 500 }));
    const file = makeFile(5 * 1024 * 1024);
    await expect(uploadInChunks({
      file, endpoint: '/api/videos/upload', target: 'video', fields: {}, onProgress: () => {},
    })).rejects.toThrow(/oops|chunk 0 failed/);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run src/frontend/lib/chunked-upload.test.ts`
Expected: FAIL with "Cannot find module './chunked-upload'".

- [ ] **Step 3: Implement the helper**

```ts
// src/frontend/lib/chunked-upload.ts
//
// Shared chunked uploader for both /upload (file picker) and /record
// (recorder takes). The endpoint accepts multipart/form-data with one chunk
// per request and returns { uploadId } so subsequent chunks can be stitched
// server-side. Kept framework-free so it can be imported from any component.

const CHUNK_SIZE = 10 * 1024 * 1024;

export type UploadTarget = 'video' | 'recorder';

export interface UploadOptions {
  file: Blob;
  endpoint: string;
  target: UploadTarget;
  /** Extra form fields merged into every chunk request. */
  fields?: Record<string, string>;
  onProgress: (fraction: number) => void;
  /** Optional file name; defaults to `'chunk'`. Only used for FormData. */
  filename?: string;
}

export interface UploadResult {
  ok: boolean;
  uploadId: string | null;
  lastResponse: Response;
}

export async function uploadInChunks(opts: UploadOptions): Promise<UploadResult> {
  const size = opts.file.size;
  const chunkCount = Math.max(1, Math.ceil(size / CHUNK_SIZE));
  let uploadId: string | null = null;
  let lastResponse: Response | null = null;

  for (let i = 0; i < chunkCount; i++) {
    const start = i * CHUNK_SIZE;
    const end = Math.min(start + CHUNK_SIZE, size);
    const type = (opts.file as File).type || 'application/octet-stream';
    const chunk = opts.file.slice(start, end, type);

    const fd = new FormData();
    for (const [k, v] of Object.entries(opts.fields ?? {})) fd.set(k, v);
    fd.set('target', opts.target);
    fd.set('chunkIndex', String(i));
    fd.set('chunkCount', String(chunkCount));
    fd.set('file', chunk, opts.filename ?? (opts.file as File).name ?? 'chunk');
    if (uploadId) fd.set('uploadId', uploadId);

    const res = await fetch(opts.endpoint, { method: 'POST', body: fd });
    lastResponse = res;
    if (!res.ok) {
      const text = await res.text().catch(() => '');
      throw new Error(`chunk ${i} failed: ${res.status} ${text}`);
    }
    if (uploadId === null) {
      try {
        const body = (await res.clone().json()) as { uploadId?: string };
        if (body.uploadId) uploadId = body.uploadId;
      } catch { /* server can omit uploadId on single-chunk uploads */ }
    }
    opts.onProgress((i + 1) / chunkCount);
  }

  return { ok: true, uploadId, lastResponse: lastResponse! };
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run src/frontend/lib/chunked-upload.test.ts`
Expected: PASS, 3/3.

- [ ] **Step 5: Refactor `Upload.tsx` to use the helper**

Open `src/frontend/pages/Upload.tsx`. Find the inlined `uploadInChunks` function (currently around lines 28-90 — confirm with `grep -n 'uploadInChunks' src/frontend/pages/Upload.tsx`). Replace its body with a delegating call:

```ts
// At top of file
import { uploadInChunks as runChunkedUpload } from '../lib/chunked-upload';

// Replace the local uploadInChunks function with:
async function uploadInChunks(
  file: File,
  title: string,
  description: string,
  onProgress: (value: number) => void,
): Promise<Response> {
  const result = await runChunkedUpload({
    file,
    endpoint: '/api/videos/upload',
    target: 'video',
    fields: { title, description },
    onProgress,
  });
  return result.lastResponse;
}
```

Leave the `CHUNK_SIZE`, `MAX_SIZE`, `ALLOWED_EXTENSIONS`, and `isAcceptedVideo` constants in `Upload.tsx` — they're page-specific (file picker concerns).

- [ ] **Step 6: Run all frontend tests to confirm no regressions**

Run: `npm run type-check && npx vitest run src/frontend/`
Expected: PASS for both. Upload-related tests still green.

- [ ] **Step 7: Commit**

```bash
git add src/frontend/lib/chunked-upload.ts src/frontend/lib/chunked-upload.test.ts src/frontend/pages/Upload.tsx
git commit -m "refactor(upload): extract chunked-upload helper for recorder reuse"
```

### Task 3: Worker upload endpoint accepts the `target` field

**Files:**
- Modify: the worker route that handles `POST /api/videos/upload` (find with `grep -rn "videos/upload" src/workers/`)
- Modify: its test file alongside it

- [ ] **Step 1: Find the existing upload route**

```bash
grep -rln "videos/upload\|'/upload'\|chunkIndex" src/workers/ | head -5
```

Note the file. The route is in `src/workers/videos.ts` or similar. Read enough of it (50-100 lines around the handler) to understand the current flow: how it accepts chunks, where it writes to R2, what key prefix it uses today.

- [ ] **Step 2: Write the failing test**

In the test file alongside the upload route, add a test:

```ts
it('writes the recorder target under recorder/raw/{userId}/{sessionId}/ when target=recorder', async () => {
  // Build app with a session user and a stub R2 binding that captures puts
  const puts: Array<{ key: string; size: number }> = [];
  const env = envFor({ VIDEOS: stubR2((key, body) => puts.push({ key, size: body.byteLength })) });
  const fd = new FormData();
  fd.set('target', 'recorder');
  fd.set('sessionId', 'sess_x');
  fd.set('takeId', 'take_001');
  fd.set('chunkIndex', '0');
  fd.set('chunkCount', '1');
  fd.set('file', new Blob([new Uint8Array(1024)], { type: 'video/webm' }), 'take_001.webm');

  const res = await buildApp({ id: 'u_1' }).request(
    '/api/videos/upload',
    { method: 'POST', body: fd },
    env,
  );
  expect(res.status).toBe(200);
  expect(puts).toHaveLength(1);
  expect(puts[0].key).toBe('recorder/raw/u_1/sess_x/take_001.webm');
});
```

(`stubR2` and `envFor` follow the existing test-file helpers — copy/adapt from the surrounding tests in the same file.)

- [ ] **Step 3: Run to verify failure**

Run: `npx vitest run src/workers/<upload-test-file>`
Expected: FAIL (target/sessionId/takeId not handled, key has wrong prefix).

- [ ] **Step 4: Implement the target switch in the upload route**

In the handler, after parsing form fields, branch on `target`:

```ts
const target = (form.get('target') as string | null) ?? 'video';
let key: string;
if (target === 'recorder') {
  const sessionId = form.get('sessionId') as string | null;
  const takeId = form.get('takeId') as string | null;
  if (!sessionId || !takeId) return c.json({ error: 'sessionId and takeId required for recorder uploads' }, 400);
  if (!/^[A-Za-z0-9_-]{1,64}$/.test(sessionId) || !/^[A-Za-z0-9_-]{1,64}$/.test(takeId)) {
    return c.json({ error: 'invalid sessionId or takeId' }, 400);
  }
  key = `recorder/raw/${user.id}/${sessionId}/${takeId}.webm`;
} else {
  key = /* existing video key derivation */;
}
```

Leave all other behavior (chunk assembly, MIME validation for `target=video`) unchanged. The `target=recorder` path skips video-file extension validation because the recorder always produces `.webm`.

- [ ] **Step 5: Run all tests to verify**

Run: `npx vitest run src/workers/`
Expected: PASS — the new test plus all existing upload tests.

- [ ] **Step 6: Commit**

```bash
git add src/workers/<upload-file>.ts src/workers/<upload-test-file>.ts
git commit -m "feat(upload): accept target=recorder to route takes under recorder/raw/"
```

---

## Phase C — Worker render routes

### Task 4: `render.ts` module skeleton + job CRUD

**Files:**
- Create: `src/workers/render.ts`
- Create: `src/workers/render.test.ts`

- [ ] **Step 1: Write failing tests for POST /api/render/jobs and GET /api/render/jobs/:id**

```ts
// src/workers/render.test.ts
import { Hono } from 'hono';
import { describe, expect, it, vi } from 'vitest';
import { renderRoutes, type RenderEnv } from './render';

type SessionUser = { id: string } | null;

function buildApp(user: SessionUser) {
  const app = new Hono<{ Bindings: RenderEnv; Variables: { user: SessionUser } }>();
  app.use('*', async (c, next) => { c.set('user', user); await next(); });
  app.route('/', renderRoutes);
  return app;
}

function stubDB() {
  const rows = new Map<string, Record<string, unknown>>();
  const db = {
    prepare(sql: string) {
      let binds: unknown[] = [];
      return {
        bind(...args: unknown[]) { binds = args; return this; },
        async run() {
          if (/^INSERT INTO render_jobs/i.test(sql)) {
            rows.set(binds[0] as string, {
              id: binds[0], user_id: binds[1], status: binds[2], progress: 0,
              composition_spec: binds[3], created_at: binds[4], updated_at: binds[4],
            });
          }
          return { success: true };
        },
        async first<T>() {
          if (/^SELECT .* FROM render_jobs WHERE id = \? AND user_id = \?/i.test(sql)) {
            const row = rows.get(binds[0] as string);
            if (row && row.user_id === binds[1]) return row as T;
            return null;
          }
          return null;
        },
      };
    },
    rows,
  } as unknown as D1Database & { rows: Map<string, Record<string, unknown>> };
  return db;
}

function stubContainer() {
  const calls: Array<{ id: string; path: string; body: unknown }> = [];
  const ns = {
    idFromName(name: string) { return { name } as unknown as DurableObjectId; },
    get(_id: DurableObjectId) {
      return { fetch: async (path: string, init?: RequestInit) => {
        calls.push({ id: (_id as unknown as { name: string }).name, path, body: init?.body ? JSON.parse(init.body as string) : null });
        return new Response('{}', { status: 200 });
      } };
    },
  } as unknown as DurableObjectNamespace & { _calls: typeof calls };
  (ns as any)._calls = calls;
  return ns;
}

function envFor(extra: Partial<RenderEnv> = {}): RenderEnv {
  return {
    DB: stubDB(),
    RENDER_CONTAINER: stubContainer(),
    RENDER_CALLBACK_SECRET: 'secret_test',
    ...extra,
  } as RenderEnv;
}

describe('POST /api/render/jobs', () => {
  it('401s when there is no session', async () => {
    const res = await buildApp(null).request(
      '/api/render/jobs',
      { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' },
      envFor(),
    );
    expect(res.status).toBe(401);
  });

  it('creates a job row, dispatches the container, and returns jobId', async () => {
    const env = envFor();
    const res = await buildApp({ id: 'u_1' }).request(
      '/api/render/jobs',
      {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          takeKeys: ['recorder/raw/u_1/s/take_001.webm'],
          compositionProps: { title: 'hi', brand: { color: '#000' }, sceneOrder: ['main'], layouts: {} },
        }),
      },
      env,
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as { jobId: string };
    expect(body.jobId).toMatch(/^j_/);
    const calls = (env.RENDER_CONTAINER as unknown as { _calls: any[] })._calls;
    expect(calls).toHaveLength(1);
    expect(calls[0].path).toBe('/render');
    expect(calls[0].id).toBe('u_1');
    expect(calls[0].body).toMatchObject({ jobId: body.jobId, takeKeys: ['recorder/raw/u_1/s/take_001.webm'] });
  });

  it('400s on missing takeKeys', async () => {
    const res = await buildApp({ id: 'u_1' }).request(
      '/api/render/jobs',
      { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ compositionProps: {} }) },
      envFor(),
    );
    expect(res.status).toBe(400);
  });
});

describe('GET /api/render/jobs/:id', () => {
  it('returns the job when owned by the session user', async () => {
    const env = envFor();
    // Create one first
    await buildApp({ id: 'u_1' }).request(
      '/api/render/jobs',
      { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({
        takeKeys: ['k'], compositionProps: {},
      }) },
      env,
    );
    const created = [...((env.DB as unknown as { rows: Map<string, any> }).rows.values())][0];
    const res = await buildApp({ id: 'u_1' }).request(
      `/api/render/jobs/${created.id}`,
      { method: 'GET' },
      env,
    );
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body).toMatchObject({ status: 'queued', progress: 0 });
  });

  it('404s when the job belongs to another user', async () => {
    const env = envFor();
    await buildApp({ id: 'u_1' }).request(
      '/api/render/jobs',
      { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ takeKeys: ['k'], compositionProps: {} }) },
      env,
    );
    const created = [...((env.DB as unknown as { rows: Map<string, any> }).rows.values())][0];
    const res = await buildApp({ id: 'u_2' }).request(`/api/render/jobs/${created.id}`, { method: 'GET' }, env);
    expect(res.status).toBe(404);
  });
});
```

- [ ] **Step 2: Run to verify failure**

Run: `npx vitest run src/workers/render.test.ts`
Expected: FAIL ("Cannot find module './render'").

- [ ] **Step 3: Implement `render.ts`**

```ts
// src/workers/render.ts
//
// Routes for the recorder render pipeline. Creating a job inserts into
// render_jobs and dispatches the user's CF Container instance to run the
// actual Remotion render. The container then posts back to the
// /complete | /fail | /progress endpoints (added in Task 5) to update the
// job state. Polling clients call GET /api/render/jobs/:id every ~2s.
//
// Per-account isolation: the container instance is keyed on user.id so each
// user's renders run in their own scale-to-zero instance.

import { Hono } from 'hono';
import { z } from 'zod';

export interface RenderEnv {
  DB: D1Database;
  RENDER_CONTAINER: DurableObjectNamespace;
  RENDER_CALLBACK_SECRET: string;
}

interface SessionUser { id: string }
type RenderVariables = { user: SessionUser | null };

const createBodySchema = z.object({
  takeKeys: z.array(z.string().min(1)).min(1),
  compositionProps: z.object({}).passthrough(),
});

export const renderRoutes = new Hono<{
  Bindings: RenderEnv;
  Variables: RenderVariables;
}>();

renderRoutes.post('/api/render/jobs', async (c) => {
  const user = c.get('user');
  if (!user) return c.json({ error: 'Unauthorized' }, 401);

  const raw = await c.req.json().catch(() => null);
  const parsed = createBodySchema.safeParse(raw);
  if (!parsed.success) {
    return c.json({ error: 'Invalid body', details: parsed.error.flatten() }, 400);
  }
  const { takeKeys, compositionProps } = parsed.data;

  const jobId = `j_${crypto.randomUUID().replace(/-/g, '').slice(0, 16)}`;
  const now = Date.now();
  await c.env.DB.prepare(
    `INSERT INTO render_jobs (id, user_id, status, composition_spec, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)`,
  ).bind(jobId, user.id, 'queued', JSON.stringify({ takeKeys, ...compositionProps }), now, now).run();

  // Fire-and-forget container dispatch. The container's /render endpoint
  // returns 200 immediately and processes asynchronously.
  const ct = c.env.RENDER_CONTAINER.get(c.env.RENDER_CONTAINER.idFromName(user.id));
  try {
    await ct.fetch('/render', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ jobId, takeKeys, compositionProps }),
    });
  } catch (err) {
    await c.env.DB.prepare(
      `UPDATE render_jobs SET status='failed', error_message=?, updated_at=? WHERE id=?`,
    ).bind(`Container dispatch failed: ${err instanceof Error ? err.message : String(err)}`, Date.now(), jobId).run();
    return c.json({ error: 'Render service unavailable' }, 503);
  }

  return c.json({ jobId });
});

renderRoutes.get('/api/render/jobs/:id', async (c) => {
  const user = c.get('user');
  if (!user) return c.json({ error: 'Unauthorized' }, 401);
  const id = c.req.param('id');
  const row = await c.env.DB.prepare(
    `SELECT id, status, progress, output_r2_key, video_id, error_message FROM render_jobs WHERE id = ? AND user_id = ?`,
  ).bind(id, user.id).first<{
    id: string;
    status: string;
    progress: number;
    output_r2_key: string | null;
    video_id: string | null;
    error_message: string | null;
  }>();
  if (!row) return c.json({ error: 'Not found' }, 404);
  return c.json({
    id: row.id,
    status: row.status,
    progress: row.progress,
    outputKey: row.output_r2_key,
    videoId: row.video_id,
    error: row.error_message,
  });
});
```

- [ ] **Step 4: Run tests to verify pass**

Run: `npx vitest run src/workers/render.test.ts`
Expected: PASS, 5/5.

- [ ] **Step 5: Commit**

```bash
git add src/workers/render.ts src/workers/render.test.ts
git commit -m "feat(render): add /api/render/jobs POST + GET routes"
```

### Task 5: Container-callback routes (`/complete`, `/fail`, `/progress`)

**Files:**
- Modify: `src/workers/render.ts` (add 3 routes + a `validateCallback` helper)
- Modify: `src/workers/render.test.ts` (add tests for each)

- [ ] **Step 1: Write the failing tests**

Append to `render.test.ts`:

```ts
describe('container callbacks', () => {
  it('POST /complete rejects without the shared secret', async () => {
    const env = envFor();
    const res = await buildApp(null).request(
      '/api/render/jobs/j_x/complete',
      { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ outputKey: 'k' }) },
      env,
    );
    expect(res.status).toBe(401);
  });

  it('POST /complete marks the job completed, creates a video row, enqueues encoding', async () => {
    // Seed a job
    const env = envFor({
      VIDEO_ENCODING: { send: vi.fn(async () => {}) } as unknown as Queue,
    });
    await buildApp({ id: 'u_1' }).request(
      '/api/render/jobs',
      { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ takeKeys: ['k'], compositionProps: {} }) },
      env,
    );
    const jobId = [...((env.DB as unknown as { rows: Map<string, any> }).rows.values())][0].id;

    const res = await buildApp(null).request(
      `/api/render/jobs/${jobId}/complete`,
      {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'x-render-secret': 'secret_test' },
        body: JSON.stringify({ outputKey: `recorder/renders/${jobId}.mp4` }),
      },
      env,
    );
    expect(res.status).toBe(200);
    const send = (env.VIDEO_ENCODING as unknown as { send: ReturnType<typeof vi.fn> }).send;
    expect(send).toHaveBeenCalledTimes(1);
  });

  it('POST /progress updates progress percentage', async () => {
    const env = envFor();
    await buildApp({ id: 'u_1' }).request(
      '/api/render/jobs',
      { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ takeKeys: ['k'], compositionProps: {} }) },
      env,
    );
    const jobId = [...((env.DB as unknown as { rows: Map<string, any> }).rows.values())][0].id;
    const res = await buildApp(null).request(
      `/api/render/jobs/${jobId}/progress`,
      { method: 'POST', headers: { 'content-type': 'application/json', 'x-render-secret': 'secret_test' }, body: JSON.stringify({ progress: 42 }) },
      env,
    );
    expect(res.status).toBe(200);
  });

  it('POST /fail marks the job failed with the supplied error', async () => {
    const env = envFor();
    await buildApp({ id: 'u_1' }).request(
      '/api/render/jobs',
      { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ takeKeys: ['k'], compositionProps: {} }) },
      env,
    );
    const jobId = [...((env.DB as unknown as { rows: Map<string, any> }).rows.values())][0].id;
    const res = await buildApp(null).request(
      `/api/render/jobs/${jobId}/fail`,
      { method: 'POST', headers: { 'content-type': 'application/json', 'x-render-secret': 'secret_test' }, body: JSON.stringify({ error: 'boom' }) },
      env,
    );
    expect(res.status).toBe(200);
  });
});
```

(Extend `stubDB` in the test file so the SELECT/UPDATE statements used by these handlers are recognized; mirror the pattern already there. Also extend `envFor` so `VIDEO_ENCODING` defaults to a no-op stub if not overridden.)

- [ ] **Step 2: Run to verify failure**

Run: `npx vitest run src/workers/render.test.ts`
Expected: FAIL on the 4 new tests.

- [ ] **Step 3: Implement the callbacks**

Add to `render.ts`:

```ts
function validateCallbackSecret(c: Parameters<Parameters<typeof renderRoutes.post>[1]>[0]): Response | null {
  const provided = c.req.header('x-render-secret');
  if (!provided || provided !== (c.env as RenderEnv).RENDER_CALLBACK_SECRET) {
    return new Response(JSON.stringify({ error: 'Unauthorized' }), { status: 401 });
  }
  return null;
}

renderRoutes.post('/api/render/jobs/:id/complete', async (c) => {
  const denied = validateCallbackSecret(c); if (denied) return denied;
  const id = c.req.param('id');
  const body = await c.req.json().catch(() => null) as { outputKey?: string } | null;
  if (!body?.outputKey) return c.json({ error: 'outputKey required' }, 400);

  // Look up the job to get user_id (needed to create the videos row).
  const job = await c.env.DB.prepare(
    `SELECT id, user_id, composition_spec FROM render_jobs WHERE id = ?`,
  ).bind(id).first<{ id: string; user_id: string; composition_spec: string }>();
  if (!job) return c.json({ error: 'Not found' }, 404);

  const spec = JSON.parse(job.composition_spec) as { title?: string };
  const videoId = `v_${crypto.randomUUID().replace(/-/g, '').slice(0, 16)}`;
  const now = Date.now();

  // Create videos row pointing at the rendered MP4. Match the existing
  // videos schema — see src/db/migrations/0001_initial.sql for columns.
  await c.env.DB.prepare(
    `INSERT INTO videos (id, user_id, title, r2_key, created_at, updated_at) VALUES (?, ?, ?, ?, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)`,
  ).bind(videoId, job.user_id, spec.title ?? 'Untitled recording', body.outputKey).run();

  await (c.env as RenderEnv & { VIDEO_ENCODING?: Queue }).VIDEO_ENCODING?.send({ videoId });

  await c.env.DB.prepare(
    `UPDATE render_jobs SET status='completed', progress=100, output_r2_key=?, video_id=?, updated_at=? WHERE id=?`,
  ).bind(body.outputKey, videoId, now, id).run();

  return c.json({ ok: true, videoId });
});

renderRoutes.post('/api/render/jobs/:id/fail', async (c) => {
  const denied = validateCallbackSecret(c); if (denied) return denied;
  const id = c.req.param('id');
  const body = await c.req.json().catch(() => null) as { error?: string } | null;
  await c.env.DB.prepare(
    `UPDATE render_jobs SET status='failed', error_message=?, updated_at=? WHERE id=?`,
  ).bind(body?.error ?? 'Unknown error', Date.now(), id).run();
  return c.json({ ok: true });
});

renderRoutes.post('/api/render/jobs/:id/progress', async (c) => {
  const denied = validateCallbackSecret(c); if (denied) return denied;
  const id = c.req.param('id');
  const body = await c.req.json().catch(() => null) as { progress?: number } | null;
  const progress = Math.max(0, Math.min(100, Math.floor(body?.progress ?? 0)));
  await c.env.DB.prepare(
    `UPDATE render_jobs SET status='rendering', progress=?, updated_at=? WHERE id=?`,
  ).bind(progress, Date.now(), id).run();
  return c.json({ ok: true });
});
```

Also extend the `RenderEnv` interface with `VIDEO_ENCODING?: Queue<{ videoId: string }>` (optional so unit tests that omit the queue still work).

- [ ] **Step 4: Run tests to confirm pass**

Run: `npx vitest run src/workers/render.test.ts`
Expected: PASS, all callback tests + the original CRUD tests.

- [ ] **Step 5: Commit**

```bash
git add src/workers/render.ts src/workers/render.test.ts
git commit -m "feat(render): add container callback routes (complete/fail/progress)"
```

### Task 6: Stuck-job cron sweep

**Files:**
- Modify: `src/workers/render.ts` (export `runStuckJobSweep`)
- Modify: `src/workers/render.test.ts` (add a sweep test)
- Modify: `src/workers/index.ts` (call `runStuckJobSweep` from the `scheduled` handler)
- Modify: `wrangler.toml` (add cron expression)

- [ ] **Step 1: Test for the sweep**

Append to `render.test.ts`:

```ts
describe('runStuckJobSweep', () => {
  it('marks jobs older than 15 minutes in rendering as failed', async () => {
    const { runStuckJobSweep } = await import('./render');
    const updated: Array<unknown[]> = [];
    const db = {
      prepare(sql: string) {
        return {
          bind(...args: unknown[]) {
            if (/UPDATE render_jobs/i.test(sql)) updated.push(args);
            return this;
          },
          async run() { return { success: true }; },
        };
      },
    } as unknown as D1Database;
    await runStuckJobSweep(db, 1_700_000_000_000);
    // Single UPDATE call with cutoff = now - 15min
    expect(updated).toHaveLength(1);
    expect(updated[0][0]).toBe('Render timeout');
    expect(updated[0][1]).toBe(1_700_000_000_000);
    expect(updated[0][2]).toBe(1_700_000_000_000 - 15 * 60 * 1000);
  });
});
```

- [ ] **Step 2: Run to verify failure**

Run: `npx vitest run src/workers/render.test.ts`
Expected: FAIL (`runStuckJobSweep` not exported).

- [ ] **Step 3: Implement the sweep**

Append to `render.ts`:

```ts
/**
 * Mark any render_jobs that have been in `rendering` for more than 15 minutes
 * as failed. Called from the `scheduled` handler every 5 minutes (see
 * wrangler.toml). Operationally cheap because the idx_render_jobs_stuck
 * index covers (status, updated_at).
 */
export async function runStuckJobSweep(db: D1Database, nowMs = Date.now()): Promise<void> {
  const cutoff = nowMs - 15 * 60 * 1000;
  await db.prepare(
    `UPDATE render_jobs SET status='failed', error_message=?, updated_at=? WHERE status='rendering' AND updated_at < ?`,
  ).bind('Render timeout', nowMs, cutoff).run();
}
```

- [ ] **Step 4: Run tests to confirm**

Run: `npx vitest run src/workers/render.test.ts`
Expected: PASS.

- [ ] **Step 5: Wire into `scheduled` handler**

Edit `src/workers/index.ts`. Find the existing `scheduled` export (it dispatches `runDeletionSweep`, `runCostMonitorSweep`, etc.). Import `runStuckJobSweep` and call it alongside:

```ts
import { renderRoutes, runStuckJobSweep, type RenderEnv } from './render';
// ...
// In scheduled(): add
await runStuckJobSweep(env.DB);
```

Mount `renderRoutes` in the main `app`:

```ts
app.route('/', renderRoutes);
```

Extend `EnvBindings` to include `RenderEnv`:

```ts
type EnvBindings = AuthEnv & VideoRoutesEnv & RenderEnv & {
  // ... existing fields ...
};
```

- [ ] **Step 6: Add cron + container binding to `wrangler.toml`**

Add a new cron entry (cron now needs both the existing daily sweep and a 5-min entry):

```toml
[triggers]
crons = ["0 2 * * *", "*/5 * * * *"]
```

Add the new container binding:

```toml
# Recorder render pipeline (sub-project #1)
[[containers]]
class_name = "RenderContainer"
image = "./container/render/Dockerfile"
max_instances = 50
sleep_after = "60s"
default_port = 8080
instance_type = "standard-3"
```

(The Dockerfile lands in Task 8; wrangler will fail validation until then. That's expected — we don't deploy from this commit yet.)

Add the secret to the documented secrets list:

```toml
# RENDER_CALLBACK_SECRET    (recorder render — random 32-byte hex, shared with the container service)
```

- [ ] **Step 7: Run type-check and full test suite**

Run: `npm run type-check && npx vitest run src/workers/`
Expected: PASS for both.

- [ ] **Step 8: Commit**

```bash
git add src/workers/render.ts src/workers/render.test.ts src/workers/index.ts wrangler.toml
git commit -m "feat(render): wire stuck-job cron sweep + mount routes + container binding"
```

---

## Phase D — Cloudflare Container

### Task 7: Container scaffold (package.json, tsconfig, queue helper)

**Files:**
- Create: `container/render/package.json`
- Create: `container/render/tsconfig.json`
- Create: `container/render/src/queue.ts`
- Create: `container/render/src/queue.test.ts`
- Create: `container/render/.gitignore` (ignore `node_modules`, `dist`)

- [ ] **Step 1: Scaffold package.json**

```json
{
  "name": "spooool-render-container",
  "version": "0.1.0",
  "private": true,
  "type": "module",
  "scripts": {
    "build": "tsc",
    "start": "node dist/server.js",
    "test": "vitest --run"
  },
  "dependencies": {
    "@remotion/renderer": "^4.0.0",
    "hono": "^4.12.18",
    "remotion": "^4.0.0",
    "@aws-sdk/client-s3": "^3.700.0"
  },
  "devDependencies": {
    "@types/node": "^20.10.6",
    "typescript": "^5.7.2",
    "vitest": "^4.1.5"
  }
}
```

Then in the directory:

```bash
cd container/render && npm install && cd -
```

Expected: clean install. If `@remotion/renderer` major version differs in real usage, pick the actual matching version from the Remotion docs and update.

- [ ] **Step 2: tsconfig.json**

```json
{
  "compilerOptions": {
    "target": "ES2022",
    "module": "ESNext",
    "moduleResolution": "Bundler",
    "outDir": "dist",
    "strict": true,
    "esModuleInterop": true,
    "skipLibCheck": true,
    "resolveJsonModule": true
  },
  "include": ["src/**/*.ts"]
}
```

- [ ] **Step 3: Write failing queue test**

```ts
// container/render/src/queue.test.ts
import { describe, expect, it } from 'vitest';
import { RenderQueue } from './queue';

describe('RenderQueue', () => {
  it('accepts up to maxPending jobs', () => {
    const q = new RenderQueue({ maxPending: 3 });
    expect(q.enqueue({ jobId: 'a' })).toBe('accepted');
    expect(q.enqueue({ jobId: 'b' })).toBe('accepted');
    expect(q.enqueue({ jobId: 'c' })).toBe('accepted');
  });

  it('rejects beyond maxPending', () => {
    const q = new RenderQueue({ maxPending: 3 });
    q.enqueue({ jobId: 'a' }); q.enqueue({ jobId: 'b' }); q.enqueue({ jobId: 'c' });
    expect(q.enqueue({ jobId: 'd' })).toBe('rejected_full');
  });

  it('next() returns FIFO ordering', () => {
    const q = new RenderQueue({ maxPending: 3 });
    q.enqueue({ jobId: 'a' }); q.enqueue({ jobId: 'b' });
    expect(q.next()?.jobId).toBe('a');
    expect(q.next()?.jobId).toBe('b');
    expect(q.next()).toBeNull();
  });
});
```

- [ ] **Step 4: Run to verify failure**

Run: `cd container/render && npx vitest run src/queue.test.ts`
Expected: FAIL (queue not implemented).

- [ ] **Step 5: Implement the queue**

```ts
// container/render/src/queue.ts
export interface QueueJob {
  jobId: string;
  takeKeys?: string[];
  compositionProps?: Record<string, unknown>;
}

export interface QueueOptions {
  maxPending: number;
}

export class RenderQueue {
  private readonly buf: QueueJob[] = [];
  constructor(private readonly opts: QueueOptions) {}

  enqueue(job: QueueJob): 'accepted' | 'rejected_full' {
    if (this.buf.length >= this.opts.maxPending) return 'rejected_full';
    this.buf.push(job);
    return 'accepted';
  }

  next(): QueueJob | null { return this.buf.shift() ?? null; }
  get size(): number { return this.buf.length; }
}
```

- [ ] **Step 6: Run tests**

Run: `cd container/render && npx vitest run`
Expected: PASS.

- [ ] **Step 7: Commit**

```bash
git add container/render/
git commit -m "feat(container): scaffold render container with queue helper"
```

### Task 8: Container HTTP server

**Files:**
- Create: `container/render/src/server.ts`
- Create: `container/render/src/server.test.ts`

- [ ] **Step 1: Test for server endpoints**

```ts
// container/render/src/server.test.ts
import { describe, expect, it, vi } from 'vitest';
import { createServer } from './server';

const noopRender = vi.fn(async () => ({ outputPath: '/tmp/out.mp4' }));
const noopUpload = vi.fn(async () => 'recorder/renders/j_x.mp4');
const noopCallback = vi.fn(async () => {});

function buildApp() {
  return createServer({
    renderJob: noopRender,
    uploadToR2: noopUpload,
    callbackToWorker: noopCallback,
    queueMax: 3,
  });
}

describe('container HTTP server', () => {
  it('GET /health returns ok', async () => {
    const app = buildApp();
    const res = await app.request('/health');
    expect(res.status).toBe(200);
  });

  it('POST /render accepts a job and returns 200', async () => {
    noopRender.mockClear(); noopUpload.mockClear(); noopCallback.mockClear();
    const app = buildApp();
    const res = await app.request('/render', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ jobId: 'j_1', takeKeys: ['k'], compositionProps: { title: 't' } }),
    });
    expect(res.status).toBe(200);
    // Render runs asynchronously after accept; wait one tick.
    await new Promise((r) => setTimeout(r, 10));
    expect(noopRender).toHaveBeenCalledTimes(1);
  });

  it('POST /render returns 429 beyond queueMax', async () => {
    const slowRender = vi.fn(async () => { await new Promise((r) => setTimeout(r, 100)); return { outputPath: '/x' }; });
    const app = createServer({
      renderJob: slowRender, uploadToR2: noopUpload, callbackToWorker: noopCallback, queueMax: 1,
    });
    const r1 = await app.request('/render', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ jobId: 'a', takeKeys: ['k'], compositionProps: {} }) });
    const r2 = await app.request('/render', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ jobId: 'b', takeKeys: ['k'], compositionProps: {} }) });
    expect(r1.status).toBe(200);
    expect(r2.status).toBe(429);
  });
});
```

- [ ] **Step 2: Run to verify failure**

Run: `cd container/render && npx vitest run`
Expected: FAIL ("Cannot find module './server'").

- [ ] **Step 3: Implement the server**

```ts
// container/render/src/server.ts
//
// HTTP entrypoint for the render container. Worker hits POST /render with
// the job spec. We immediately accept (200) or reject for capacity (429),
// then asynchronously: render via @remotion/renderer, upload the MP4 to R2,
// and POST back to the worker's /complete (or /fail on error) endpoint.
//
// In-memory queue (max 3 pending) keeps each container instance from being
// hammered. Since the worker dispatches one instance per user, this also
// bounds how many simultaneous renders one user can run.

import { Hono } from 'hono';
import { RenderQueue } from './queue';

export interface ServerDeps {
  renderJob: (job: { jobId: string; takeKeys: string[]; compositionProps: Record<string, unknown>; onProgress: (pct: number) => void }) => Promise<{ outputPath: string }>;
  uploadToR2: (jobId: string, localPath: string) => Promise<string>;
  callbackToWorker: (path: string, body: unknown) => Promise<void>;
  queueMax: number;
}

export function createServer(deps: ServerDeps) {
  const queue = new RenderQueue({ maxPending: deps.queueMax });
  let running = false;

  async function drain(): Promise<void> {
    if (running) return;
    running = true;
    try {
      let job = queue.next();
      while (job) {
        try {
          await deps.callbackToWorker(`/api/render/jobs/${job.jobId}/progress`, { progress: 0 });
          const onProgress = (pct: number) => {
            void deps.callbackToWorker(`/api/render/jobs/${job!.jobId}/progress`, { progress: pct });
          };
          const { outputPath } = await deps.renderJob({
            jobId: job.jobId,
            takeKeys: job.takeKeys ?? [],
            compositionProps: job.compositionProps ?? {},
            onProgress,
          });
          const key = await deps.uploadToR2(job.jobId, outputPath);
          await deps.callbackToWorker(`/api/render/jobs/${job.jobId}/complete`, { outputKey: key });
        } catch (err) {
          await deps.callbackToWorker(`/api/render/jobs/${job.jobId}/fail`, {
            error: err instanceof Error ? err.message : String(err),
          }).catch(() => {});
        }
        job = queue.next();
      }
    } finally {
      running = false;
    }
  }

  const app = new Hono();
  app.get('/health', (c) => c.json({ ok: true }));
  app.post('/render', async (c) => {
    const body = await c.req.json().catch(() => null) as { jobId?: string; takeKeys?: string[]; compositionProps?: Record<string, unknown> } | null;
    if (!body?.jobId) return c.json({ error: 'jobId required' }, 400);
    const result = queue.enqueue({ jobId: body.jobId, takeKeys: body.takeKeys, compositionProps: body.compositionProps });
    if (result === 'rejected_full') return c.json({ error: 'queue full' }, 429);
    void drain();
    return c.json({ ok: true });
  });
  return app;
}
```

- [ ] **Step 4: Run tests to confirm**

Run: `cd container/render && npx vitest run`
Expected: PASS for all queue + server tests.

- [ ] **Step 5: Commit**

```bash
git add container/render/src/server.ts container/render/src/server.test.ts
git commit -m "feat(container): HTTP server with queue-backed render endpoint"
```

### Task 9: Render harness (`renderJob`, `uploadToR2`, `callbackToWorker` deps)

**Files:**
- Create: `container/render/src/render.ts`
- Create: `container/render/src/render.test.ts`
- Modify: `container/render/src/server.ts` (entry-point glue that constructs the app with real deps)

- [ ] **Step 1: Test for renderJob (mocked Remotion)**

```ts
// container/render/src/render.test.ts
import { describe, expect, it, vi } from 'vitest';
import { renderJob, type RemotionRenderer } from './render';

describe('renderJob', () => {
  it('downloads each take, calls the renderer, returns local output path', async () => {
    const downloaded: string[] = [];
    const renderer: RemotionRenderer = {
      bundle: vi.fn(async () => '/bundle'),
      selectComposition: vi.fn(async () => ({ id: 'spooool-video', durationInFrames: 300, fps: 30, width: 1920, height: 1080 })),
      renderMedia: vi.fn(async (opts: { onProgress?: (p: { progress: number }) => void }) => {
        opts.onProgress?.({ progress: 0.5 });
        opts.onProgress?.({ progress: 1 });
      }),
    };
    const downloadTake = vi.fn(async (key: string, dest: string) => { downloaded.push(`${key}->${dest}`); });
    const onProgressCalls: number[] = [];

    const result = await renderJob({
      jobId: 'j_1',
      takeKeys: ['recorder/raw/u/s/take_001.webm', 'recorder/raw/u/s/take_002.webm'],
      compositionProps: { title: 'hello', sceneOrder: ['main'] },
      onProgress: (p) => onProgressCalls.push(p),
    }, { renderer, downloadTake, tmpDir: '/tmp' });

    expect(result.outputPath).toMatch(/j_1\.mp4$/);
    expect(renderer.renderMedia).toHaveBeenCalledTimes(1);
    expect(downloaded).toEqual([
      'recorder/raw/u/s/take_001.webm->/tmp/j_1/take_001.webm',
      'recorder/raw/u/s/take_002.webm->/tmp/j_1/take_002.webm',
    ]);
    expect(onProgressCalls).toEqual([50, 100]);
  });
});
```

- [ ] **Step 2: Run to verify failure**

Run: `cd container/render && npx vitest run src/render.test.ts`
Expected: FAIL.

- [ ] **Step 3: Implement `renderJob` (Remotion glue, no real I/O yet)**

```ts
// container/render/src/render.ts
//
// Glue between the queued render job and Remotion's renderer. Pure of side
// effects so unit tests can inject the renderer + a fake take-downloader.
// The real renderer (bundle + selectComposition + renderMedia) is plugged
// in by the production entrypoint; tests pass a stub.

import path from 'node:path';

export interface RemotionRenderer {
  bundle: (entryPoint: string) => Promise<string>;
  selectComposition: (args: { serveUrl: string; id: string; inputProps: Record<string, unknown> }) => Promise<{ id: string; durationInFrames: number; fps: number; width: number; height: number }>;
  renderMedia: (args: {
    composition: { id: string; durationInFrames: number; fps: number; width: number; height: number };
    serveUrl: string;
    codec: 'h264';
    outputLocation: string;
    inputProps: Record<string, unknown>;
    onProgress?: (p: { progress: number }) => void;
  }) => Promise<void>;
}

export interface RenderJobInput {
  jobId: string;
  takeKeys: string[];
  compositionProps: Record<string, unknown>;
  onProgress: (pct: number) => void;
}

export interface RenderJobDeps {
  renderer: RemotionRenderer;
  downloadTake: (key: string, destPath: string) => Promise<void>;
  tmpDir: string;
  /** Resolves to the bundled Remotion serve URL. Defaults to bundling
      `./remotion/index.ts` lazily on first use. */
  serveUrl?: string;
  remotionEntry?: string;
}

let cachedServeUrl: string | null = null;

export async function renderJob(input: RenderJobInput, deps: RenderJobDeps): Promise<{ outputPath: string }> {
  const jobDir = path.join(deps.tmpDir, input.jobId);
  // Download every take into the job's temp dir under its takeId.
  await Promise.all(input.takeKeys.map(async (key) => {
    const takeId = path.basename(key);
    await deps.downloadTake(key, path.join(jobDir, takeId));
  }));

  const serveUrl =
    deps.serveUrl ??
    cachedServeUrl ??
    (cachedServeUrl = await deps.renderer.bundle(deps.remotionEntry ?? path.resolve('./remotion/index.ts')));

  const composition = await deps.renderer.selectComposition({
    serveUrl,
    id: 'spooool-video',
    inputProps: { takes: input.takeKeys, ...input.compositionProps },
  });

  const outputPath = path.join(jobDir, `${input.jobId}.mp4`);
  await deps.renderer.renderMedia({
    composition,
    serveUrl,
    codec: 'h264',
    outputLocation: outputPath,
    inputProps: { takes: input.takeKeys, ...input.compositionProps },
    onProgress: (p) => input.onProgress(Math.round(p.progress * 100)),
  });

  return { outputPath };
}
```

- [ ] **Step 4: Run tests to confirm pass**

Run: `cd container/render && npx vitest run`
Expected: PASS.

- [ ] **Step 5: Production entrypoint — bring in real `@remotion/renderer` + R2 + worker callbacks**

Append to `container/render/src/server.ts` a bottom block that bootstraps a live `createServer(...)` when the file is executed directly (Node CLI). Stub:

```ts
// --- Production entrypoint (runs when `node dist/server.js` starts) ---
if (import.meta.url === `file://${process.argv[1]}`) {
  const { bundle } = await import('@remotion/bundler');
  const { renderMedia, selectComposition } = await import('@remotion/renderer');
  const { S3Client, GetObjectCommand, PutObjectCommand } = await import('@aws-sdk/client-s3');
  const fs = await import('node:fs/promises');
  const path = await import('node:path');

  const s3 = new S3Client({
    region: 'auto',
    endpoint: process.env.R2_S3_ENDPOINT!,
    credentials: { accessKeyId: process.env.R2_ACCESS_KEY_ID!, secretAccessKey: process.env.R2_SECRET_ACCESS_KEY! },
  });
  const bucket = process.env.R2_BUCKET ?? 'spooool-videos';
  const workerBase = process.env.WORKER_BASE_URL ?? 'https://spooool.com';
  const callbackSecret = process.env.RENDER_CALLBACK_SECRET!;

  const downloadTake = async (key: string, dest: string) => {
    await fs.mkdir(path.dirname(dest), { recursive: true });
    const out = await s3.send(new GetObjectCommand({ Bucket: bucket, Key: key }));
    const buf = Buffer.from(await out.Body!.transformToByteArray());
    await fs.writeFile(dest, buf);
  };

  const { renderJob } = await import('./render.js');

  const app = createServer({
    renderJob: (input) => renderJob(input, {
      renderer: { bundle, selectComposition: (a) => selectComposition(a as any) as any, renderMedia: (a) => renderMedia(a as any) as any },
      downloadTake,
      tmpDir: '/tmp',
    }),
    uploadToR2: async (jobId, localPath) => {
      const key = `recorder/renders/${jobId}.mp4`;
      const body = await fs.readFile(localPath);
      await s3.send(new PutObjectCommand({ Bucket: bucket, Key: key, Body: body, ContentType: 'video/mp4' }));
      return key;
    },
    callbackToWorker: async (callbackPath, body) => {
      await fetch(`${workerBase}${callbackPath}`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'x-render-secret': callbackSecret },
        body: JSON.stringify(body),
      });
    },
    queueMax: 3,
  });

  const { serve } = await import('@hono/node-server');
  serve({ fetch: app.fetch, port: Number(process.env.PORT ?? 8080) });
}
```

Add the missing deps to `container/render/package.json`:

```json
"@remotion/bundler": "^4.0.0",
"@hono/node-server": "^1.13.0"
```

then re-install (`cd container/render && npm install && cd -`).

- [ ] **Step 6: Tests still green?**

Run: `cd container/render && npx vitest run`
Expected: PASS. The production-entrypoint block is guarded by `import.meta.url` so tests don't trigger it.

- [ ] **Step 7: Commit**

```bash
git add container/render/
git commit -m "feat(container): render harness + production entrypoint"
```

### Task 10: Container Dockerfile

**Files:**
- Create: `container/render/Dockerfile`

- [ ] **Step 1: Write the Dockerfile**

```Dockerfile
# Render container for spooool's recorder pipeline (sub-project #1).
# Runs @remotion/renderer which needs Chromium + ffmpeg available on PATH.
# Built and deployed via `wrangler deploy` (see wrangler.toml [[containers]]).

FROM node:22-bookworm-slim

# System dependencies. Chromium is installed via Debian's chromium package.
# ffmpeg comes from main; both ship recent-enough versions for Remotion 4.
RUN apt-get update && apt-get install -y --no-install-recommends \
      chromium \
      ffmpeg \
      ca-certificates \
      fonts-liberation \
      libnss3 \
      libatk-bridge2.0-0 \
      libdrm2 \
      libxkbcommon0 \
      libgbm1 \
      libasound2 \
    && rm -rf /var/lib/apt/lists/*

# Point Remotion at the system Chromium so it doesn't try to download one.
ENV REMOTION_CHROME_PATH=/usr/bin/chromium
ENV CHROMIUM_PATH=/usr/bin/chromium

WORKDIR /app

# Install Node deps first so layer cache survives source changes.
COPY package.json package-lock.json* ./
RUN npm ci --omit=dev

# Copy app sources + Remotion compositions, then compile.
COPY tsconfig.json ./
COPY src ./src
COPY remotion ./remotion
RUN npx tsc

EXPOSE 8080
CMD ["node", "dist/server.js"]
```

- [ ] **Step 2: Local build smoke (optional but recommended)**

```bash
cd container/render && docker build -t spooool-render:local . && cd -
```

Expected: image builds. Don't run it — it needs env vars that prod supplies.

- [ ] **Step 3: Commit**

```bash
git add container/render/Dockerfile
git commit -m "feat(container): Dockerfile (node + chromium + ffmpeg + remotion)"
```

---

## Phase E — Port Remotion compositions

### Task 11: Port `remotion/` from the recorder repo

**Files:**
- Create: `container/render/remotion/` (full directory ported from `remotion-dev/recorder` `remotion/`)

- [ ] **Step 1: Clone the upstream recorder into a scratch dir**

```bash
mkdir -p /tmp/recorder-port && cd /tmp/recorder-port && \
  gh repo clone remotion-dev/recorder . && cd -
```

- [ ] **Step 2: Copy the `remotion/` folder**

```bash
cp -r /tmp/recorder-port/remotion container/render/remotion
```

- [ ] **Step 3: Audit and trim**

Open `container/render/remotion/index.ts` (or `Root.tsx`, whichever is the Remotion entrypoint) and confirm there's a composition with `id="spooool-video"`. If the entrypoint registers it under a different ID, rename either the ID in the composition or the lookup in `container/render/src/render.ts` (Task 9, Step 3) so they match.

Replace the input-props schema to expect:

```ts
{
  takes: string[];        // R2 keys
  title?: string;
  brand?: { color?: string; logoUrl?: string };
  sceneOrder?: string[];  // e.g. ['intro','main','outro']
  layouts?: Record<string, unknown>;
}
```

Remove any recorder-repo-specific config files that don't apply (e.g. their own user-facing config form that the original repo uses for the recorder UI in Remotion preview — we don't need it in the container).

- [ ] **Step 4: Local Remotion preview smoke**

```bash
cd container/render && npx remotion preview remotion/index.ts && cd -
```

Expected: Remotion's preview launches with the composition. If it errors, fix paths/imports in the ported files until the preview renders. You can ctrl-C out once you confirm it loads.

- [ ] **Step 5: Re-run unit tests**

Run: `cd container/render && npx vitest run`
Expected: PASS (the unit tests stub the renderer, so a working composition isn't required for tests — but the imports must still resolve).

- [ ] **Step 6: Commit**

```bash
git add container/render/remotion/
git commit -m "feat(container): port Remotion compositions from remotion-dev/recorder"
```

### Task 12: Wire takes into the composition

**Files:**
- Modify: `container/render/remotion/` (the main composition component)

The recorder upstream expects takes via filesystem paths the Remotion dev server can serve. Our container has them in `/tmp/{jobId}/{takeId}.webm` after `downloadTake`. We need the composition to load takes from those paths.

- [ ] **Step 1: Adapt the take loader**

In the main composition (likely `MainScene.tsx`/`Recording.tsx` in the ported tree), find where the upstream loads takes (search the tree for `<Video src=` or `staticFile(`). Replace with reads from `/tmp/{jobId}/{takeId}.webm`. The composition receives `takes: string[]` (R2 keys) in `inputProps`; map each key to its local path via `path.basename(key)` and prefix with the jobDir.

For Remotion `<Video>`, paths under the bundler's serve URL must be `staticFile()`-resolved OR served via the `public/` folder. The cleanest path for a container render: write takes into `<bundleDir>/public/{jobId}/{takeId}.webm` before invoking `renderMedia`. Update `render.ts` (Task 9) to download into `${bundleDir}/public/{jobId}/` instead of `${tmpDir}/{jobId}/`.

- [ ] **Step 2: Smoke render manually (offline)**

In `container/render/`:

```bash
mkdir -p public/test_job && cp /path/to/any-local.webm public/test_job/take_001.webm
npx remotion render remotion/index.ts spooool-video out.mp4 \
  --props='{"takes":["public/test_job/take_001.webm"],"title":"Hello","sceneOrder":["main"]}'
```

Expected: `out.mp4` is produced. If Remotion can't find Chromium, install it system-wide locally or skip this step and rely on Docker for the real test.

- [ ] **Step 3: Commit**

```bash
git add container/render/
git commit -m "feat(container): wire downloaded takes into Remotion composition"
```

---

## Phase F — Frontend recorder UI

### Task 13: Port the recorder repo's `src/` into spooool

**Files:**
- Create: `src/frontend/recorder/` (entire directory, ported from `remotion-dev/recorder` `src/`)

- [ ] **Step 1: Copy the recorder UI tree**

```bash
cp -r /tmp/recorder-port/src src/frontend/recorder
```

- [ ] **Step 2: Audit imports for Next.js / Node patterns**

```bash
grep -rln "next/\|use client\|use server\|process\.env\.NEXT_PUBLIC" src/frontend/recorder/ | head -20
```

Expected: no hits. The recorder is a Remotion template (not Next.js). If any hits show up, they are unrelated stubs and can be deleted or replaced with browser-only equivalents.

- [ ] **Step 3: Wire the recorder's auth-aware bits to `auth-client`**

Search for any hardcoded user/session reads in the ported tree:

```bash
grep -rn "userId\|currentUser\|session" src/frontend/recorder/ | head -20
```

Replace any session shims with `useSession()` from `../lib/auth-client`. Block the recorder behind `user?.emailVerified === true`; show a "verify your email first" prompt otherwise.

- [ ] **Step 4: Compile-check**

Run: `npm run type-check`
Expected: PASS. Resolve any import-path errors by editing the recorder files (they'll have repo-relative imports that may need adjusting for spooool's tsconfig paths).

- [ ] **Step 5: Commit**

```bash
git add src/frontend/recorder/
git commit -m "feat(recorder): port recorder UI source from remotion-dev/recorder"
```

### Task 14: Replace the recorder's local file save with chunked R2 upload

**Files:**
- Modify: the recorder file(s) that write recorded takes to disk in the upstream repo (search for `fs.writeFile`, `Blob`, `URL.createObjectURL` in `src/frontend/recorder/`).

The upstream recorder is designed to drop takes onto the local disk (the Remotion dev server reads them from `public/`). In spooool, takes must instead upload to R2 via our chunked endpoint.

- [ ] **Step 1: Find the take-save site**

```bash
grep -rn "saveTake\|writeFile\|webm\|MediaRecorder\|VideoEncoder" src/frontend/recorder/ | head -20
```

- [ ] **Step 2: Replace with chunked-upload + return the R2 key**

Where each completed take is currently saved locally, change it to call `uploadInChunks` from `../lib/chunked-upload`:

```ts
import { uploadInChunks } from '../lib/chunked-upload';

async function persistTake(blob: Blob, sessionId: string, takeId: string): Promise<string> {
  const result = await uploadInChunks({
    file: blob,
    endpoint: '/api/videos/upload',
    target: 'recorder',
    fields: { sessionId, takeId },
    filename: `${takeId}.webm`,
    onProgress: () => {},
  });
  if (!result.ok) throw new Error('Take upload failed');
  return `recorder/raw/${'__SELF__'}/${sessionId}/${takeId}.webm`;
}
```

The `${'__SELF__'}` substring is a placeholder — the worker writes the take under the authenticated user's id (which the client doesn't need to know). To make the R2 key available to the eventual `/api/render/jobs` call, change `persistTake` to instead RETURN whatever the worker echoes back. Modify the worker upload route to include `r2Key` in its JSON response on the final chunk:

```ts
return c.json({ uploadId, r2Key: key, target });
```

And in the recorder:

```ts
const body = (await result.lastResponse.json()) as { r2Key: string };
return body.r2Key;
```

This requires also touching the upload route added in Task 3 to include `r2Key` in the response. Add a unit test there for the response shape if not already present.

- [ ] **Step 3: Commit**

```bash
git add src/frontend/recorder/ src/workers/<upload>.ts src/workers/<upload>.test.ts
git commit -m "feat(recorder): upload takes to R2 via chunked endpoint"
```

### Task 15: Composition preview with `@remotion/player`

**Files:**
- Modify: `package.json` (add `@remotion/player`, `remotion`)
- Modify: a component in `src/frontend/recorder/` that previews the composition before render

- [ ] **Step 1: Add deps**

```bash
npm install @remotion/player remotion
```

- [ ] **Step 2: Add a preview component**

Find where the "ready to render" / "review" step lives in the ported UI (after takes complete, before "Create video" is clicked). Render an inline preview:

```tsx
import { Player } from '@remotion/player';
import { MainScene } from './remotion/MainScene'; // or wherever the ported composition entry lives in src/frontend/recorder/remotion

export function CompositionPreview({ takes, props }: { takes: string[]; props: Record<string, unknown> }) {
  return (
    <Player
      component={MainScene}
      durationInFrames={300}
      compositionWidth={1920}
      compositionHeight={1080}
      fps={30}
      style={{ width: '100%' }}
      controls
      inputProps={{ takes, ...props }}
    />
  );
}
```

If the ported recorder doesn't already include a `MainScene` (or has it under a different name), copy the composition source into `src/frontend/recorder/remotion/` so both the in-browser preview and the container render share the same source of truth — but adapt it for browser playback (Player loads takes from URLs, so wire `<Video src={`/api/recorder/takes/${key}`} />` via a worker route, OR play back local IndexedDB blobs via blob URLs).

For v1 simplicity: skip the live preview if it's significant work in this task, gate behind a `?preview=1` flag, and ship the "Create video" → server render → wait → watch flow first. Polish the in-browser preview in a follow-up.

- [ ] **Step 3: Compile + lint**

Run: `npm run type-check && npm run lint`
Expected: PASS.

- [ ] **Step 4: Commit**

```bash
git add package.json package-lock.json src/frontend/recorder/
git commit -m "feat(recorder): inline composition preview via @remotion/player"
```

### Task 16: Render job submission + polling UI

**Files:**
- Create: `src/frontend/recorder/lib/render-jobs.ts`
- Create: `src/frontend/recorder/RenderProgress.tsx`
- Modify: the recorder's "Create video" CTA handler

- [ ] **Step 1: Implement the API client**

```ts
// src/frontend/recorder/lib/render-jobs.ts
export interface RenderJobStatus {
  id: string;
  status: 'queued' | 'rendering' | 'completed' | 'failed';
  progress: number;
  outputKey: string | null;
  videoId: string | null;
  error: string | null;
}

export async function createRenderJob(args: {
  takeKeys: string[];
  compositionProps: Record<string, unknown>;
}): Promise<{ jobId: string }> {
  const res = await fetch('/api/render/jobs', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(args),
  });
  if (!res.ok) throw new Error(`Render request failed: ${res.status}`);
  return res.json() as Promise<{ jobId: string }>;
}

export async function fetchRenderStatus(jobId: string): Promise<RenderJobStatus> {
  const res = await fetch(`/api/render/jobs/${jobId}`);
  if (!res.ok) throw new Error(`Status fetch failed: ${res.status}`);
  return res.json() as Promise<RenderJobStatus>;
}
```

- [ ] **Step 2: Progress component with polling**

```tsx
// src/frontend/recorder/RenderProgress.tsx
import { useEffect, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { fetchRenderStatus, type RenderJobStatus } from './lib/render-jobs';

export function RenderProgress({ jobId }: { jobId: string }): JSX.Element {
  const [status, setStatus] = useState<RenderJobStatus | null>(null);
  const navigate = useNavigate();

  useEffect(() => {
    let cancelled = false;
    let timer: ReturnType<typeof setTimeout> | null = null;
    async function poll() {
      try {
        const s = await fetchRenderStatus(jobId);
        if (cancelled) return;
        setStatus(s);
        if (s.status === 'completed' && s.videoId) {
          navigate(`/watch/${s.videoId}`, { replace: true });
          return;
        }
        if (s.status === 'failed') return;
      } catch { /* keep polling on transient errors */ }
      timer = setTimeout(poll, 2000);
    }
    void poll();
    return () => { cancelled = true; if (timer) clearTimeout(timer); };
  }, [jobId, navigate]);

  if (!status) return <p>Starting render…</p>;
  if (status.status === 'failed') return <p role="alert">Render failed: {status.error ?? 'unknown error'}</p>;
  return (
    <div>
      <p>{status.status === 'queued' ? 'Queued…' : `Rendering ${status.progress}%`}</p>
      <progress value={status.progress} max={100} />
      <p style={{ opacity: 0.7 }}>This usually takes a couple minutes.</p>
    </div>
  );
}
```

- [ ] **Step 3: Wire the CTA**

In the recorder's "ready to render" step, on Create-video click:

```tsx
const [jobId, setJobId] = useState<string | null>(null);
const onCreate = async () => {
  const { jobId } = await createRenderJob({ takeKeys, compositionProps });
  setJobId(jobId);
};
if (jobId) return <RenderProgress jobId={jobId} />;
return <button onClick={() => void onCreate()}>Create video</button>;
```

- [ ] **Step 4: Compile-check**

Run: `npm run type-check`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/frontend/recorder/
git commit -m "feat(recorder): submit render job + poll for completion"
```

### Task 17: Register `/record` route + entry component

**Files:**
- Create: `src/frontend/pages/Record.tsx` (small page that mounts the recorder)
- Modify: `src/frontend/App.tsx` (add the route)

- [ ] **Step 1: Page wrapper**

```tsx
// src/frontend/pages/Record.tsx
import { Navigate } from 'react-router-dom';
import { useSession } from '../lib/auth-client';
import { RecorderRoot } from '../recorder';

export function Record(): JSX.Element {
  const { data: session, isPending } = useSession();
  if (isPending) return <p>Loading…</p>;
  if (!session) return <Navigate to="/login" state={{ from: '/record' }} replace />;
  if (!session.user.emailVerified) {
    return (
      <main className="app-main app-main--narrow">
        <h1>Verify your email to record</h1>
        <p>Recording is unlocked after you confirm your email address.</p>
      </main>
    );
  }
  if (!('VideoEncoder' in window)) {
    return (
      <main className="app-main app-main--narrow">
        <h1>Browser not supported</h1>
        <p>The recorder needs a modern browser with WebCodecs (Chrome, Edge, or Firefox 130+). On unsupported browsers please use the <a href="/upload">upload page</a> instead.</p>
      </main>
    );
  }
  return <RecorderRoot />;
}
```

(Assumes the ported recorder exposes a top-level `RecorderRoot` from `src/frontend/recorder/index.ts`. Add the export if missing.)

- [ ] **Step 2: Register the route**

In `src/frontend/App.tsx`, find the `<Route ... path="/upload" .../>` line and add an adjacent `/record` route:

```tsx
import { Record } from './pages/Record';
// ...
<Route path="/record" element={<Record />} />
```

- [ ] **Step 3: Compile + smoke**

```bash
npm run dev
```

Expected: dev server starts. Visit `http://localhost:5173/record` — you should see either the recorder UI, the email-verify gate, or the unsupported-browser message depending on your session.

- [ ] **Step 4: Commit**

```bash
git add src/frontend/pages/Record.tsx src/frontend/App.tsx
git commit -m "feat(recorder): mount /record route with auth + browser support gates"
```

---

## Phase G — E2E + docs

### Task 18: Playwright smoke for the full pipeline

**Files:**
- Create: `tests/e2e/record.spec.ts`

- [ ] **Step 1: Write the E2E test**

```ts
// tests/e2e/record.spec.ts
import { test, expect } from '@playwright/test';

test('record flow lands on the watch page', async ({ page, context }) => {
  // Fake getUserMedia / getDisplayMedia so headless Chromium returns a synthetic stream.
  await context.addInitScript(() => {
    const canvas = document.createElement('canvas');
    canvas.width = 640; canvas.height = 480;
    const stream = canvas.captureStream(30);
    navigator.mediaDevices.getUserMedia = async () => stream as MediaStream;
    (navigator.mediaDevices as any).getDisplayMedia = async () => stream as MediaStream;
  });

  // Sign in via the existing E2E setup (see playwright.config.ts and any
  // existing tests/e2e/ for the project-standard auth pattern — copy that).
  // If no E2E auth helper exists yet, add a `tests/e2e/lib/sign-in.ts`
  // helper that hits /api/auth/sign-in/email with a pre-seeded test user;
  // adding that helper is a small precursor to running this test.
  await page.goto('http://localhost:5173/record');
  await expect(page.getByRole('button', { name: /create video|start recording/i })).toBeVisible();

  // Drive a 2-second recording, then create video. Selectors here depend on
  // the ported recorder UI — adjust to actual labels after Task 13.
  await page.getByRole('button', { name: /start recording/i }).click();
  await page.waitForTimeout(2500);
  await page.getByRole('button', { name: /stop/i }).click();
  await page.getByRole('button', { name: /create video/i }).click();

  // Poll the page until it navigates to a watch URL OR fails.
  await page.waitForURL(/\/watch\//, { timeout: 5 * 60_000 });
});
```

- [ ] **Step 2: Run it (against a local dev environment)**

```bash
npm run dev &
DEV_PID=$!
npx playwright test tests/e2e/record.spec.ts
kill $DEV_PID
```

Expected: PASS. If selectors don't match the ported UI's actual labels, edit the test until it does.

- [ ] **Step 3: Commit**

```bash
git add tests/e2e/record.spec.ts
git commit -m "test(recorder): playwright e2e for record → render → watch"
```

### Task 19: Smoke-test runbook + ship checklist + R2 lifecycle rule

**Files:**
- Create: `docs/runbooks/recorder-smoke-test.md`
- Manual (CF dashboard): R2 lifecycle rule on `recorder/raw/` (7-day delete)

- [ ] **Step 1: Write the runbook**

```markdown
# Recorder pipeline smoke test

Manual checklist for things `tests/e2e/record.spec.ts` can't catch (real
camera, mic, screen capture per OS, render quality, audio sync).

## Pre-flight
- [ ] Last successful prod deploy is recent (see `gh run list --workflow=deploy-prod.yml --limit 1`)
- [ ] `RENDER_CALLBACK_SECRET` is set in both the worker secrets and the container env vars and matches
- [ ] Cloudflare Container `RenderContainer` shows healthy in the dashboard
- [ ] `auth.pdx.software` route still in place (we serve the auth flow from there)

## Happy path
- [ ] Sign in as a verified user
- [ ] Open `/record`
- [ ] Grant camera + mic permissions
- [ ] Record a 5-second talking-head take
- [ ] Add a screen-share take (full window or single tab)
- [ ] Preview the composition (or skip if preview is gated)
- [ ] Click "Create video"
- [ ] Confirm progress bar climbs to 100%
- [ ] Confirm browser navigates to `/watch/:videoId`
- [ ] Confirm video plays end-to-end in the player
- [ ] Confirm audio is in sync with video

## Failure surfaces
- [ ] Deny camera permission → expect "enable permissions" message
- [ ] Cancel screen-share dialog → expect graceful continue
- [ ] Use Safari → expect "browser not supported" fallback to `/upload`
- [ ] Submit 4 simultaneous renders for the same user → expect the 4th to get a 429 with retry-after

## Cleanup
- [ ] After 7 days, `recorder/raw/<userId>/<sessionId>/` is empty in R2 (lifecycle rule)
```

- [ ] **Step 2: Configure R2 lifecycle rule (CF dashboard, manual)**

The spec calls for `recorder/raw/` to auto-delete after 7 days. R2 lifecycle rules aren't yet managed by wrangler.

1. Cloudflare Dashboard → R2 → `spooool-videos` bucket → Settings → Object lifecycle rules → Add rule.
2. Name: `recorder-raw-7d`. Prefix: `recorder/raw/`. Action: Delete objects 7 days after upload.
3. Verify the rule appears in the bucket settings page.

- [ ] **Step 3: Commit**

```bash
git add docs/runbooks/recorder-smoke-test.md
git commit -m "docs(recorder): smoke-test runbook"
```

---

## Self-review checklist

After implementing, run through the spec one more time:

- [ ] `render_jobs` table created with both indexes (Task 1)
- [ ] Chunked upload extracted + Upload.tsx still works (Tasks 2–3)
- [ ] All four worker routes (`POST /jobs`, `GET /jobs/:id`, `POST /complete`, `POST /fail`, `POST /progress`) covered by tests (Tasks 4–5)
- [ ] Stuck-render cron wired into `scheduled` handler and `wrangler.toml` (Task 6)
- [ ] Container has Dockerfile, queue (max 3), server, render harness, tests (Tasks 7–10)
- [ ] Remotion compositions ported and accept the documented input-props shape (Tasks 11–12)
- [ ] Frontend `/record` mounted, recorder UI ported, takes upload via chunked endpoint, render submission + polling works (Tasks 13–17)
- [ ] Playwright E2E and manual smoke runbook exist (Tasks 18–19)
- [ ] `RENDER_CALLBACK_SECRET`, `R2_S3_ENDPOINT`, `R2_ACCESS_KEY_ID`, `R2_SECRET_ACCESS_KEY`, `R2_BUCKET`, `WORKER_BASE_URL` documented as required container env vars
- [ ] Memory note about Polar (not Stripe) for payments — recording-as-paid-feature is out of scope here; no payment code in this plan
- [ ] AI Gateway rule respected — no direct model SDK calls; nothing in this plan needs LLM inference
