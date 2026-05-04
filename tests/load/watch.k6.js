// ALO-174: 1k concurrent watcher load test.
//
// Simulates the dominant traffic pattern — anonymous users hitting the
// trending list, picking a video, fetching its metadata, then streaming
// chunks via Range requests. Doesn't try to mimic real ABR (hls.js
// segment fetches at variable bitrates) — for that we'd need a far more
// elaborate scenario. This baseline catches origin-CPU / D1-pool
// regressions before they show up as user-visible latency.
//
// Run: BASE_URL=https://spooool.workers.dev k6 run tests/load/watch.k6.js
//
// Required env:
//   BASE_URL — origin to hit (default: http://localhost:5173)
//   VIDEO_ID — known-good video id served by the target environment.
//              If unset, the script falls back to grabbing the first
//              trending video at start-up; if trending is empty the test
//              aborts with a setup error rather than spamming 404s.
//   STREAM_BYTES — Range request size in bytes (default 524288 = 512KB)
//
// Budget (from the parent ticket — "1k concurrent watchers"):
//   - p95 trending-list latency  < 400ms
//   - p95 video-meta latency     < 250ms
//   - p95 stream Range latency   < 800ms
//   - request failure rate       < 1%

import http from 'k6/http';
import { check, fail, sleep } from 'k6';
import { Trend } from 'k6/metrics';

const BASE_URL = __ENV.BASE_URL || 'http://localhost:5173';
const STREAM_BYTES = parseInt(__ENV.STREAM_BYTES || '524288', 10);

export const options = {
  scenarios: {
    watchers: {
      executor: 'ramping-vus',
      startVUs: 0,
      stages: [
        { duration: '30s', target: 100 },
        { duration: '1m', target: 500 },
        { duration: '2m', target: 1000 },
        { duration: '2m', target: 1000 }, // hold at peak
        { duration: '30s', target: 0 },
      ],
      gracefulRampDown: '10s',
    },
  },
  thresholds: {
    http_req_failed: ['rate<0.01'],
    'trending_ms{kind:trending}': ['p(95)<400'],
    'video_meta_ms{kind:meta}': ['p(95)<250'],
    'stream_ms{kind:stream}': ['p(95)<800'],
  },
};

const trendingTrend = new Trend('trending_ms', true);
const metaTrend = new Trend('video_meta_ms', true);
const streamTrend = new Trend('stream_ms', true);

export function setup() {
  let videoId = __ENV.VIDEO_ID;
  if (!videoId) {
    const res = http.get(`${BASE_URL}/api/videos/trending?limit=20`);
    if (res.status !== 200) {
      fail(`trending fetch failed at setup: ${res.status} ${res.body}`);
    }
    const body = res.json();
    if (!body || !Array.isArray(body.videos) || body.videos.length === 0) {
      fail(
        'trending returned no videos; pass VIDEO_ID=<id> for a known-good clip',
      );
    }
    videoId = body.videos[0].id;
  }
  return { videoId };
}

export default function (data) {
  // 1. Trending list — landing page request.
  const trending = http.get(`${BASE_URL}/api/videos/trending?limit=12`, {
    tags: { kind: 'trending' },
  });
  trendingTrend.add(trending.timings.duration);
  check(trending, { 'trending 200': (r) => r.status === 200 });

  // 2. Video metadata — picked from setup (or VIDEO_ID env).
  const meta = http.get(`${BASE_URL}/api/videos/${data.videoId}`, {
    tags: { kind: 'meta' },
  });
  metaTrend.add(meta.timings.duration);
  check(meta, { 'meta 200': (r) => r.status === 200 });

  // 3. Stream a Range chunk (the actual heavy path).
  const stream = http.get(
    `${BASE_URL}/api/videos/${data.videoId}/stream`,
    {
      headers: { Range: `bytes=0-${STREAM_BYTES - 1}` },
      tags: { kind: 'stream' },
    },
  );
  streamTrend.add(stream.timings.duration);
  check(stream, {
    'stream 206 or 200': (r) => r.status === 206 || r.status === 200,
  });

  // Modest think time so we don't peg every VU into a tight loop —
  // real watchers spend most of the session passively pulling chunks.
  sleep(1);
}
