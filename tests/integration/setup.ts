/// <reference path="../../node_modules/@cloudflare/vitest-pool-workers/types/cloudflare-test.d.ts" />
import { applyD1Migrations, env } from 'cloudflare:test';
import { afterEach, beforeAll } from 'vitest';

import type { D1Migration } from 'cloudflare:test';

declare global {
  namespace Cloudflare {
    interface Env {
      DB: D1Database;
      VIDEOS: R2Bucket;
      CACHE: KVNamespace;
      SESSIONS: KVNamespace;
      VIDEO_ENCODING: Queue;
      TEST_MIGRATIONS: D1Migration[];
    }
  }
}

beforeAll(async () => {
  await applyD1Migrations(env.DB, env.TEST_MIGRATIONS);
});

// Clear KV between tests so the trending-cache versioning doesn't leak
// state from one test into the next. D1/R2 are wiped per-test in the
// individual specs that need it.
afterEach(async () => {
  const keys = await env.CACHE.list();
  await Promise.all(keys.keys.map((k: { name: string }) => env.CACHE.delete(k.name)));
});
