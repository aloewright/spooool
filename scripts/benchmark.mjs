#!/usr/bin/env node
/**
 * Cloudflare Worker CPU-time benchmark script.
 *
 * Measures wall-clock latency for the key API endpoints and computes p50/p95/p99
 * percentiles. Run against a local `wrangler dev` instance or a deployed URL.
 *
 * Usage:
 *   node scripts/benchmark.mjs [BASE_URL] [--rounds N] [--concurrency N]
 *
 * Examples:
 *   node scripts/benchmark.mjs http://localhost:8787
 *   node scripts/benchmark.mjs https://your-worker.workers.dev --rounds 100
 *   node scripts/benchmark.mjs http://localhost:8787 --concurrency 5
 *
 * Tips for reading CF CPU time from wrangler dev:
 *   Use `wrangler dev --inspector-port 9229` and observe "CPU time" in the
 *   devtools Network tab, or check the `cf-cache-status` / `x-spooool-cache`
 *   response headers to distinguish KV hits from D1 hits in the latency data.
 */

import { parseArgs } from 'node:util';

const { values, positionals } = parseArgs({
  args: process.argv.slice(2),
  options: {
    rounds: { type: 'string', default: '50' },
    concurrency: { type: 'string', default: '1' },
    cookie: { type: 'string' }, // session cookie for auth'd endpoints, e.g. "better-auth.session_token=xxx"
  },
  allowPositionals: true,
});

const BASE_URL = positionals[0] ?? 'http://localhost:8787';
const ROUNDS = parseInt(values.rounds, 10);
const CONCURRENCY = parseInt(values.concurrency, 10);
const SESSION_COOKIE = values.cookie ?? '';

function pct(sorted, p) {
  const idx = Math.ceil((p / 100) * sorted.length) - 1;
  return sorted[Math.max(0, idx)];
}

async function time(label, fn) {
  const samples = [];
  const batches = Math.ceil(ROUNDS / CONCURRENCY);

  for (let b = 0; b < batches; b++) {
    const batch = Array.from({ length: Math.min(CONCURRENCY, ROUNDS - b * CONCURRENCY) }, () =>
      (async () => {
        const t0 = performance.now();
        const result = await fn();
        const elapsed = performance.now() - t0;
        return { elapsed, status: result.status };
      })(),
    );
    const results = await Promise.all(batch);
    for (const r of results) samples.push(r);
  }

  const sorted = samples.map((s) => s.elapsed).sort((a, b) => a - b);
  const errCount = samples.filter((s) => s.status >= 400).length;

  console.log(
    `${label.padEnd(42)} ` +
    `p50=${pct(sorted, 50).toFixed(1).padStart(7)}ms ` +
    `p95=${pct(sorted, 95).toFixed(1).padStart(7)}ms ` +
    `p99=${pct(sorted, 99).toFixed(1).padStart(7)}ms ` +
    `n=${String(ROUNDS).padStart(4)} ` +
    (errCount ? `\x1b[31merrors=${errCount}\x1b[0m` : 'ok'),
  );
}

async function get(path, headers = {}) {
  return fetch(`${BASE_URL}${path}`, {
    headers: {
      accept: 'application/json',
      ...(SESSION_COOKIE ? { cookie: SESSION_COOKIE } : {}),
      ...headers,
    },
  });
}

// ---------------------------------------------------------------------------
// Benchmark suites
// ---------------------------------------------------------------------------

console.log(`\nBenchmarking ${BASE_URL} (${ROUNDS} rounds, concurrency=${CONCURRENCY})\n`);

// Public / unauthenticated endpoints

await time('GET /api/health', () => get('/api/health'));

// Trending — first call populates KV, subsequent calls should be cache hits.
await time('GET /api/videos/trending (limit=12)', () => get('/api/videos/trending?limit=12'));

// List videos — no KV cache, hits D1 directly.
await time('GET /api/videos (page=1)', () => get('/api/videos?page=1&limit=20'));

// Known video — supply a real videoId to test KV cache hit vs miss patterns.
const VIDEO_ID = process.env.BENCH_VIDEO_ID ?? '';
if (VIDEO_ID) {
  await time(`GET /api/videos/${VIDEO_ID} (KV cache)`, () => get(`/api/videos/${VIDEO_ID}`));
  await time(`GET /api/videos/${VIDEO_ID}/hls/master.m3u8`, () => get(`/api/videos/${VIDEO_ID}/hls/master.m3u8`));

  // Range request — tests R2 latency.
  await time(`GET /api/videos/${VIDEO_ID}/stream (range)`, () =>
    get(`/api/videos/${VIDEO_ID}/stream`, { range: 'bytes=0-65535' }),
  );
}

// Heartbeat — high-frequency endpoint; benefits most from KV cache hit path.
if (VIDEO_ID && SESSION_COOKIE) {
  await time(`POST /api/videos/${VIDEO_ID}/heartbeat`, () =>
    fetch(`${BASE_URL}/api/videos/${VIDEO_ID}/heartbeat`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        cookie: SESSION_COOKIE,
      },
      body: JSON.stringify({ delta: 10, position: 30 }),
    }),
  );
}

// Render job poll — supply a real jobId to benchmark KV cache effectiveness.
const JOB_ID = process.env.BENCH_JOB_ID ?? '';
if (JOB_ID && SESSION_COOKIE) {
  await time(`GET /api/render/jobs/${JOB_ID}`, () =>
    get(`/api/render/jobs/${JOB_ID}`),
  );
}

// Feeds
const FEED_ID = process.env.BENCH_FEED_ID ?? '';
if (FEED_ID && SESSION_COOKIE) {
  await time(`GET /api/feeds/${FEED_ID}/items`, () => get(`/api/feeds/${FEED_ID}/items`));
}

// Search
await time('GET /api/search?q=test', () => get('/api/search?q=test'));

console.log('\nDone.\n');
console.log('Tips:');
console.log('  Set BENCH_VIDEO_ID, BENCH_JOB_ID, BENCH_FEED_ID env vars to test auth\'d endpoints.');
console.log('  Pass --cookie "better-auth.session_token=..." for session-gated routes.');
console.log('  Run with --rounds 200 for tighter percentiles.');
