/// <reference types="@cloudflare/vitest-pool-workers/types" />

declare namespace Cloudflare {
  interface Env {
    DB: D1Database;
    CACHE: KVNamespace;
    SESSIONS: KVNamespace;
    VIDEOS: R2Bucket;
    TEST_MIGRATIONS: import('cloudflare:test').D1Migration[];
    CF_STREAM_WEBHOOK_SECRET?: string;
  }
}
