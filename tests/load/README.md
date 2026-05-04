# Load tests (ALO-174)

k6 scripts that exercise the dominant traffic patterns at our baseline scale targets:

| Script | Pattern | Peak load | Budget |
|---|---|---|---|
| `watch.k6.js` | Anonymous watchers — trending → meta → Range-streamed chunk | **1,000 concurrent VUs** | p95 stream Range < 800ms; failure rate < 1% |
| `upload.k6.js` | Authenticated uploaders — signup → init upload (chunk 0 only) | **50 concurrent VUs** | p95 init < 2.5s; failure rate < 2% |

Numbers come from the parent ticket. They're intentionally conservative for an MVP — we're stress-testing the worker / D1 / R2 perimeter, not exhausting Cloudflare's edge.

## Install k6

```sh
brew install k6        # macOS
# or
choco install k6       # Windows
# or use the docker image:
# docker run --rm -i grafana/k6 run - <tests/load/watch.k6.js
```

## Run

Always set `BASE_URL` to a non-prod environment. **Never run these against `cloudflare-tube-prod`** without coordination — even at 1k VUs you'll burn Worker invocations + D1 quota + R2 egress quickly.

```sh
# Watch baseline
BASE_URL=https://spooool-staging.workers.dev k6 run tests/load/watch.k6.js

# Upload baseline
BASE_URL=https://spooool-staging.workers.dev k6 run tests/load/upload.k6.js
```

For the watch test, k6 needs a known-good video id. By default it grabs the first trending video, but if trending is empty (fresh staging) pass it explicitly:

```sh
BASE_URL=... VIDEO_ID=abc123 k6 run tests/load/watch.k6.js
```

Adjust the Range chunk size for the watch test (default 512KB):

```sh
STREAM_BYTES=2097152 k6 run tests/load/watch.k6.js
```

## Reading the output

k6's summary at the end of each run prints the trends + threshold pass/fail. Anything tagged `{kind:trending|meta|stream|init}` rolls up into the named metrics in `options.thresholds`. A failed threshold ends the process with a non-zero exit code, which is useful when wired into CI.

## What's not covered

- **Real chunk-by-chunk upload throughput** — would need a real fixture file and a multi-iteration scenario per VU. The init-only stress here catches D1 / R2-multipart-create pressure, which is where the regressions actually land.
- **HLS ABR ladder fetches** — hls.js issues many small Range requests at variable bitrates; the watch script approximates with a single big Range. For more realistic playback simulation, consider running browser-driven Playwright tests against the staging environment instead.

## CI

These scripts are **not** wired into the standard CI workflow — load tests at this scale belong on a runner with predictable bandwidth and an opt-in trigger, not every PR. The intended path is a manual workflow_dispatch GitHub Action that runs against the staging environment on demand. Filed as a follow-up alongside ALO-190 (staging provisioning).
