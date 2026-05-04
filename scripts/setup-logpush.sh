#!/usr/bin/env bash
# ALO-166 / observability: provision a Workers Logpush job that ships every
# log line from the spooool worker to the cloudflare-tube-logs R2 bucket.
#
# Logpush jobs are account-level resources and aren't managed by wrangler,
# so this script is the one-shot setup. Re-running is idempotent: it lists
# existing jobs and skips when one already targets our bucket.
#
# Required env:
#   CLOUDFLARE_API_TOKEN   account-scoped token with Logs Edit + R2 Read
#   CLOUDFLARE_ACCOUNT_ID  account id (visible in the dashboard sidebar)
#
# Optional env:
#   LOGS_BUCKET            override the R2 bucket name (default: cloudflare-tube-logs)
#   WORKER_NAME            override the worker name      (default: spooool)
#
# Usage:
#   doppler run -- scripts/setup-logpush.sh
#   # or, with bare env:
#   CLOUDFLARE_API_TOKEN=... CLOUDFLARE_ACCOUNT_ID=... scripts/setup-logpush.sh

set -euo pipefail

: "${CLOUDFLARE_API_TOKEN:?missing CLOUDFLARE_API_TOKEN}"
: "${CLOUDFLARE_ACCOUNT_ID:?missing CLOUDFLARE_ACCOUNT_ID}"

LOGS_BUCKET="${LOGS_BUCKET:-cloudflare-tube-logs}"
WORKER_NAME="${WORKER_NAME:-spooool}"

api() {
  curl -fsS -H "Authorization: Bearer ${CLOUDFLARE_API_TOKEN}" \
       -H "Content-Type: application/json" "$@"
}

# 1. Ensure the destination R2 bucket exists. wrangler.toml binds it but
#    the bucket itself has to be created first.
if ! api -X GET \
  "https://api.cloudflare.com/client/v4/accounts/${CLOUDFLARE_ACCOUNT_ID}/r2/buckets/${LOGS_BUCKET}" \
  >/dev/null 2>&1; then
  echo ">> Creating R2 bucket ${LOGS_BUCKET}"
  api -X POST \
    "https://api.cloudflare.com/client/v4/accounts/${CLOUDFLARE_ACCOUNT_ID}/r2/buckets" \
    --data "{\"name\":\"${LOGS_BUCKET}\"}" >/dev/null
else
  echo ">> R2 bucket ${LOGS_BUCKET} already exists"
fi

# 2. Skip if a Logpush job for this worker already exists.
EXISTING=$(api -X GET \
  "https://api.cloudflare.com/client/v4/accounts/${CLOUDFLARE_ACCOUNT_ID}/logpush/jobs" \
  | jq -r --arg ws "${WORKER_NAME}" \
      '.result[]? | select(.dataset == "workers_trace_events" and (.filter // "" | contains($ws))) | .id')
if [ -n "${EXISTING}" ]; then
  echo ">> Logpush job already exists (id=${EXISTING}); nothing to do."
  exit 0
fi

# 3. Create the job. The R2 destination_conf format is documented at
#    https://developers.cloudflare.com/logs/get-started/enable-destinations/r2/
DEST="r2://${LOGS_BUCKET}/spooool-worker/{DATE}?account-id=${CLOUDFLARE_ACCOUNT_ID}&access-key-id=${R2_ACCESS_KEY_ID:-}&secret-access-key=${R2_SECRET_ACCESS_KEY:-}"

echo ">> Creating Logpush job for worker ${WORKER_NAME} -> ${LOGS_BUCKET}"
api -X POST \
  "https://api.cloudflare.com/client/v4/accounts/${CLOUDFLARE_ACCOUNT_ID}/logpush/jobs" \
  --data "$(jq -n \
    --arg name "spooool-worker-logs" \
    --arg dest "${DEST}" \
    --arg filter "{\"where\":{\"key\":\"ScriptName\",\"operator\":\"eq\",\"value\":\"${WORKER_NAME}\"}}" \
    '{
       name: $name,
       dataset: "workers_trace_events",
       destination_conf: $dest,
       enabled: true,
       max_upload_bytes: 5000000,
       max_upload_records: 1000,
       max_upload_interval_seconds: 30,
       filter: $filter,
       output_options: {
         output_type: "ndjson",
         field_names: [
           "Event",
           "EventTimestampMs",
           "Outcome",
           "ScriptName",
           "ScriptVersion",
           "Logs",
           "Exceptions",
           "DispatchNamespace"
         ]
       }
     }')" >/dev/null

echo ">> Logpush job created. Verify with:"
echo "   curl -H \"Authorization: Bearer \$CLOUDFLARE_API_TOKEN\" \\"
echo "        https://api.cloudflare.com/client/v4/accounts/\$CLOUDFLARE_ACCOUNT_ID/logpush/jobs"
