import { describe, expect, it } from 'vitest';
import { Hono } from 'hono';
import {
  COUNTER_NOTICE_WAIT_DAYS,
  COUNTER_NOTICE_WAIT_MS,
  dmcaRoutes,
  runDmcaRestoreSweep,
  type DmcaSweepEnv,
} from './dmca';

describe('counter-notice wait constants', () => {
  it('is 14 days in ms', () => {
    expect(COUNTER_NOTICE_WAIT_DAYS).toBe(14);
    expect(COUNTER_NOTICE_WAIT_MS).toBe(14 * 24 * 60 * 60 * 1000);
  });
});

interface FakeStore {
  videos: Map<
    string,
    {
      id: string;
      user_id: string;
      deleted_at: string | null;
      dmca_status: string | null;
      dmca_restore_eligible_at: number | null;
    }
  >;
  claims: Map<
    string,
    { id: string; video_id: string; status: string; updated_at: number }
  >;
  counters: Array<{ id: string; claim_id: string }>;
  cacheDeletes: string[];
}

function makeStore(): FakeStore {
  return {
    videos: new Map([
      [
        'v1',
        {
          id: 'v1',
          user_id: 'u-uploader',
          deleted_at: null,
          dmca_status: null,
          dmca_restore_eligible_at: null,
        },
      ],
    ]),
    claims: new Map(),
    counters: [],
    cacheDeletes: [],
  };
}

interface PreparedStmt {
  bind(...values: unknown[]): PreparedStmt;
  first<T = unknown>(): Promise<T | null>;
  all<T = unknown>(): Promise<{ results: T[] }>;
  run(): Promise<{ success: boolean }>;
}

function fakeKV(deletes: string[]): KVNamespace {
  return {
    delete: async (k: string) => deletes.push(k),
    get: async () => null,
    put: async () => {},
  } as unknown as KVNamespace;
}

function fakeDB(store: FakeStore): D1Database {
  const stmt = (sql: string): PreparedStmt => {
    let bound: unknown[] = [];
    const trimmed = sql.replace(/\s+/g, ' ').trim();
    const api: PreparedStmt = {
      bind(...v) {
        bound = v;
        return api;
      },
      async first<T>() {
        if (trimmed.startsWith('SELECT id FROM videos WHERE id =')) {
          const v = store.videos.get(bound[0] as string);
          return (v && !v.deleted_at ? { id: v.id } : null) as T | null;
        }
        if (trimmed.startsWith('SELECT c.id, c.video_id, c.status, v.user_id AS uploader_user_id')) {
          const claim = store.claims.get(bound[0] as string);
          if (!claim) return null;
          const video = store.videos.get(claim.video_id);
          if (!video) return null;
          return {
            id: claim.id,
            video_id: claim.video_id,
            status: claim.status,
            uploader_user_id: video.user_id,
          } as T;
        }
        if (trimmed.startsWith('SELECT c.id, c.video_id, c.status, u.email AS uploader_email')) {
          const c = store.claims.get(bound[0] as string);
          if (!c) return null;
          return { ...c, uploader_email: 'uploader@example.com' } as unknown as T;
        }
        return null;
      },
      async all<T>() {
        if (trimmed.startsWith('SELECT id, video_id, complainant_name')) {
          return { results: [...store.claims.values()] as unknown as T[] };
        }
        if (trimmed.startsWith('SELECT v.id AS video_id, c.id AS claim_id')) {
          const cutoff = bound[0] as number;
          const out: { video_id: string; claim_id: string }[] = [];
          for (const claim of store.claims.values()) {
            const video = store.videos.get(claim.video_id);
            if (!video) continue;
            if (
              video.dmca_status === 'disabled' &&
              video.dmca_restore_eligible_at != null &&
              video.dmca_restore_eligible_at <= cutoff &&
              claim.status === 'counter_pending'
            ) {
              out.push({ video_id: claim.video_id, claim_id: claim.id });
            }
          }
          return { results: out as unknown as T[] };
        }
        return { results: [] as T[] };
      },
      async run() {
        if (trimmed.startsWith('INSERT INTO dmca_claims')) {
          store.claims.set(bound[0] as string, {
            id: bound[0] as string,
            video_id: bound[1] as string,
            status: 'pending',
            updated_at: bound[13] as number,
          });
        } else if (trimmed.startsWith('INSERT INTO dmca_counter_notices')) {
          store.counters.push({ id: bound[0] as string, claim_id: bound[1] as string });
        } else if (
          trimmed.startsWith("UPDATE dmca_claims SET status = 'counter_pending'")
        ) {
          const c = store.claims.get(bound[1] as string);
          if (c) {
            c.status = 'counter_pending';
            c.updated_at = bound[0] as number;
          }
        } else if (trimmed.startsWith("UPDATE dmca_claims SET status = 'disabled'")) {
          const c = store.claims.get(bound[1] as string);
          if (c) {
            c.status = 'disabled';
            c.updated_at = bound[0] as number;
          }
        } else if (trimmed.startsWith("UPDATE dmca_claims SET status = 'dismissed'")) {
          const c = store.claims.get(bound[1] as string);
          if (c) {
            c.status = 'dismissed';
            c.updated_at = bound[0] as number;
          }
        } else if (trimmed.startsWith("UPDATE dmca_claims SET status = 'restored'")) {
          const c = store.claims.get(bound[1] as string);
          if (c) {
            c.status = 'restored';
            c.updated_at = bound[0] as number;
          }
        } else if (trimmed.startsWith("UPDATE videos SET dmca_status = 'disabled'")) {
          const v = store.videos.get(bound[0] as string);
          if (v) v.dmca_status = 'disabled';
        } else if (trimmed.startsWith('UPDATE videos SET dmca_status = NULL')) {
          const v = store.videos.get(bound[0] as string);
          if (v) {
            v.dmca_status = null;
            v.dmca_restore_eligible_at = null;
          }
        } else if (trimmed.startsWith('UPDATE videos SET dmca_restore_eligible_at')) {
          const v = store.videos.get(bound[1] as string);
          if (v) v.dmca_restore_eligible_at = bound[0] as number;
        }
        return { success: true };
      },
    };
    return api;
  };
  return { prepare: (sql: string) => stmt(sql) } as unknown as D1Database;
}

type Ctx = { Variables: { user: { id: string; email: string; name: string } | null } };

function appAs(store: FakeStore, user: { id: string } | null) {
  const app = new Hono<Ctx>();
  app.use('*', async (c, next) => {
    c.set('user', user ? { id: user.id, email: 'x@y.com', name: 'x' } : null);
    await next();
  });
  app.route('/', dmcaRoutes);
  return {
    async post(path: string, body?: unknown) {
      return app.fetch(
        new Request(`http://t${path}`, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: body ? JSON.stringify(body) : undefined,
        }),
        { DB: fakeDB(store), CACHE: fakeKV(store.cacheDeletes) } as never,
      );
    },
  };
}

const VALID_SUBMISSION = {
  videoId: 'v1',
  complainantName: 'Jane Doe',
  complainantEmail: 'jane@example.com',
  complainantAddress: '1 Main St',
  complainantPhone: '+1-555-0100',
  copyrightedWork: 'My film',
  infringingUrls: ['https://spooool.com/watch/v1'],
  goodFaithSigned: true,
  perjurySigned: true,
  signature: 'Jane Doe',
};

describe('DMCA submission validation', () => {
  it('accepts a valid submission and persists it', async () => {
    const store = makeStore();
    const app = appAs(store, null);
    const res = await app.post('/api/dmca/submission', VALID_SUBMISSION);
    expect(res.status).toBe(201);
    expect(store.claims.size).toBe(1);
  });

  it('rejects a submission missing the perjury checkbox', async () => {
    const store = makeStore();
    const app = appAs(store, null);
    const res = await app.post('/api/dmca/submission', { ...VALID_SUBMISSION, perjurySigned: false });
    expect(res.status).toBe(400);
    expect(store.claims.size).toBe(0);
  });

  it('rejects a submission missing the good-faith checkbox', async () => {
    const store = makeStore();
    const app = appAs(store, null);
    const res = await app.post('/api/dmca/submission', { ...VALID_SUBMISSION, goodFaithSigned: false });
    expect(res.status).toBe(400);
  });

  it('rejects a submission with no signature', async () => {
    const store = makeStore();
    const app = appAs(store, null);
    const res = await app.post('/api/dmca/submission', { ...VALID_SUBMISSION, signature: '' });
    expect(res.status).toBe(400);
  });

  it('rejects a submission for a non-existent video', async () => {
    const store = makeStore();
    const app = appAs(store, null);
    const res = await app.post('/api/dmca/submission', { ...VALID_SUBMISSION, videoId: 'missing' });
    expect(res.status).toBe(404);
  });
});

describe('DMCA disable / restore state machine', () => {
  it('admin disable flips video status and busts cache; counter-notice sets restore-eligible date', async () => {
    const store = makeStore();
    const submitterApp = appAs(store, null);
    const submitRes = await submitterApp.post('/api/dmca/submission', VALID_SUBMISSION);
    const { id: claimId } = (await submitRes.json()) as { id: string };

    const adminApp = appAs(store, { id: 'admin' });
    await adminApp.post(`/api/admin/dmca/${claimId}/decision`, { action: 'disable' });
    expect(store.videos.get('v1')?.dmca_status).toBe('disabled');
    expect(store.cacheDeletes).toContain('video:v1:v1');
    expect(store.claims.get(claimId)?.status).toBe('disabled');

    // Uploader files counter-notice
    const uploaderApp = appAs(store, { id: 'u-uploader' });
    const counterRes = await uploaderApp.post('/api/dmca/counter', {
      claimId,
      uploaderName: 'U',
      uploaderAddress: 'A',
      uploaderPhone: 'P',
      uploaderEmail: 'u@example.com',
      statement: 'I made it myself.',
      signature: 'U',
      consentToJurisdiction: true,
    });
    expect(counterRes.status).toBe(201);
    expect(store.claims.get(claimId)?.status).toBe('counter_pending');
    expect(store.videos.get('v1')?.dmca_restore_eligible_at).toBeGreaterThan(Date.now());
  });

  it('counter-notice from a different user is forbidden', async () => {
    const store = makeStore();
    const submitterApp = appAs(store, null);
    const submitRes = await submitterApp.post('/api/dmca/submission', VALID_SUBMISSION);
    const { id: claimId } = (await submitRes.json()) as { id: string };

    const adminApp = appAs(store, { id: 'admin' });
    await adminApp.post(`/api/admin/dmca/${claimId}/decision`, { action: 'disable' });

    const otherApp = appAs(store, { id: 'someone-else' });
    const res = await otherApp.post('/api/dmca/counter', {
      claimId,
      uploaderName: 'U',
      uploaderAddress: 'A',
      uploaderPhone: 'P',
      uploaderEmail: 'u@example.com',
      statement: 'mine',
      signature: 'U',
      consentToJurisdiction: true,
    });
    expect(res.status).toBe(403);
  });

  it('counter-notice on a non-disabled claim is rejected', async () => {
    const store = makeStore();
    const submitterApp = appAs(store, null);
    const submitRes = await submitterApp.post('/api/dmca/submission', VALID_SUBMISSION);
    const { id: claimId } = (await submitRes.json()) as { id: string };

    const uploaderApp = appAs(store, { id: 'u-uploader' });
    const res = await uploaderApp.post('/api/dmca/counter', {
      claimId,
      uploaderName: 'U',
      uploaderAddress: 'A',
      uploaderPhone: 'P',
      uploaderEmail: 'u@example.com',
      statement: 'mine',
      signature: 'U',
      consentToJurisdiction: true,
    });
    expect(res.status).toBe(400);
  });

  it('admin dismiss does NOT disable the video and marks the claim dismissed', async () => {
    const store = makeStore();
    const submitterApp = appAs(store, null);
    const submitRes = await submitterApp.post('/api/dmca/submission', VALID_SUBMISSION);
    const { id: claimId } = (await submitRes.json()) as { id: string };

    const adminApp = appAs(store, { id: 'admin' });
    await adminApp.post(`/api/admin/dmca/${claimId}/decision`, { action: 'dismiss' });
    expect(store.videos.get('v1')?.dmca_status).toBeNull();
    expect(store.claims.get(claimId)?.status).toBe('dismissed');
  });
});

describe('runDmcaRestoreSweep', () => {
  it('restores videos whose counter-notice waiting period has elapsed', async () => {
    const store = makeStore();
    // seed: a claim in counter_pending with elapsed timer
    store.claims.set('c1', { id: 'c1', video_id: 'v1', status: 'counter_pending', updated_at: 0 });
    const v = store.videos.get('v1');
    if (!v) throw new Error('seed failed');
    v.dmca_status = 'disabled';
    v.dmca_restore_eligible_at = Date.now() - 1000;

    const env: DmcaSweepEnv = {
      DB: fakeDB(store),
      CACHE: fakeKV(store.cacheDeletes),
    };
    const restored = await runDmcaRestoreSweep(env);
    expect(restored).toEqual(['v1']);
    expect(store.videos.get('v1')?.dmca_status).toBeNull();
    expect(store.claims.get('c1')?.status).toBe('restored');
    expect(store.cacheDeletes).toContain('video:v1:v1');
  });

  it('leaves videos whose waiting period has not elapsed', async () => {
    const store = makeStore();
    store.claims.set('c1', { id: 'c1', video_id: 'v1', status: 'counter_pending', updated_at: 0 });
    const v = store.videos.get('v1');
    if (!v) throw new Error('seed failed');
    v.dmca_status = 'disabled';
    v.dmca_restore_eligible_at = Date.now() + 24 * 60 * 60 * 1000;

    const env: DmcaSweepEnv = {
      DB: fakeDB(store),
      CACHE: fakeKV(store.cacheDeletes),
    };
    const restored = await runDmcaRestoreSweep(env);
    expect(restored).toEqual([]);
    expect(store.videos.get('v1')?.dmca_status).toBe('disabled');
  });
});
