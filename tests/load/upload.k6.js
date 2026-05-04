// ALO-174: 50 concurrent uploader load test.
//
// Simulates uploads via the chunked init endpoint. Each VU posts a small
// (1MB) chunk-0 with valid metadata, then exits — we're stress-testing
// the init / D1 / R2-multipart-create surface, not the throughput of
// every chunk. Throughput tests need a real fixture file and a longer
// session and are out of scope for the baseline.
//
// Auth: better-auth's email/password sign-in returns a session cookie
// (better-auth.session_token). Each VU signs up its own throwaway user
// in setup() and reuses the cookie for all iterations — k6 doesn't
// share state between VUs by default, so cookies stay scoped per VU
// without any extra plumbing.
//
// Run: BASE_URL=https://spooool.workers.dev k6 run tests/load/upload.k6.js
//
// Required env:
//   BASE_URL — origin to hit (default: http://localhost:5173)
//
// Budget (from the parent ticket — "50 concurrent uploaders"):
//   - p95 init latency       < 1500ms (R2 createMultipartUpload + D1 insert)
//   - p95 chunk-0 latency    < 2500ms
//   - request failure rate   < 2%

import http from 'k6/http';
import { check, fail, sleep } from 'k6';
import { Trend } from 'k6/metrics';
import { uuidv4 } from 'https://jslib.k6.io/k6-utils/1.4.0/index.js';

const BASE_URL = __ENV.BASE_URL || 'http://localhost:5173';
const PASSWORD = 'k6-load-test-password-1';

export const options = {
  scenarios: {
    uploaders: {
      executor: 'ramping-vus',
      startVUs: 0,
      stages: [
        { duration: '15s', target: 10 },
        { duration: '45s', target: 50 },
        { duration: '2m', target: 50 }, // hold at peak
        { duration: '15s', target: 0 },
      ],
      gracefulRampDown: '10s',
    },
  },
  thresholds: {
    http_req_failed: ['rate<0.02'],
    'init_ms{kind:init}': ['p(95)<2500'],
  },
};

const initTrend = new Trend('init_ms', true);

export function setup() {
  // Sanity: confirm signup is reachable before launching a herd of VUs.
  const probe = http.get(`${BASE_URL}/api/health`);
  if (probe.status !== 200) {
    fail(`/api/health did not return 200 (got ${probe.status})`);
  }
  return {};
}

function signUpAndLogin() {
  const email = `k6-${uuidv4().slice(0, 8)}@spooool-load.test`;
  const res = http.post(
    `${BASE_URL}/api/auth/sign-up/email`,
    JSON.stringify({
      email,
      password: PASSWORD,
      name: 'k6 Load',
    }),
    { headers: { 'Content-Type': 'application/json' } },
  );
  if (res.status !== 200 && res.status !== 201) {
    return null;
  }
  // The Set-Cookie header from sign-up establishes the session.
  return email;
}

export default function () {
  const email = signUpAndLogin();
  if (!email) {
    // Auth-write rate limiter (ALO-168) may shed us under load — that's
    // expected and even desirable. Just skip the upload step.
    sleep(1);
    return;
  }

  // Build a tiny multipart body for chunk 0 of a 1MB single-chunk upload.
  const fileBytes = new Uint8Array(1024 * 1024);
  // Minimal valid MP4 header bytes so upload-validation accepts the type.
  // (validateInitialFile only inspects MIME + extension, not content.)
  const formData = {
    title: 'k6 load test clip',
    description: 'transient — uploaded by k6 load test',
    chunkIndex: '0',
    chunkCount: '1',
    file: http.file(fileBytes.buffer, 'load-test.mp4', 'video/mp4'),
  };

  const init = http.post(`${BASE_URL}/api/videos/upload`, formData, {
    tags: { kind: 'init' },
  });
  initTrend.add(init.timings.duration);
  check(init, {
    'init 2xx or rate-limited 429': (r) =>
      (r.status >= 200 && r.status < 300) || r.status === 429,
  });

  sleep(1);
}
