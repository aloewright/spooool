#!/usr/bin/env bash
# ALO-190: One-time provisioning of the staging queue + DLQ.
#
# Cloudflare Queues are NOT auto-created by `wrangler deploy`; the deploy
# fails with "queue not found" until both queues exist. The Cloudflare
# Developer Platform MCP / API does not expose a queues.create endpoint
# either, so we shell out to the wrangler CLI here.
#
# Re-running is safe: wrangler returns a non-zero exit + "already exists"
# error which we swallow.
#
# Requires: CLOUDFLARE_API_TOKEN + CLOUDFLARE_ACCOUNT_ID in the env
# (Doppler-managed in CI; `doppler run -- ./scripts/setup-staging-queue.sh`
# locally).

set -u

create_queue() {
  local name="$1"
  echo "→ creating queue: ${name}"
  if npx wrangler queues create "${name}" 2>&1 | tee /tmp/wrangler-queues.log; then
    return 0
  fi
  if grep -qiE 'already exists|already in use' /tmp/wrangler-queues.log; then
    echo "  (already exists — skipping)"
    return 0
  fi
  echo "  ✗ failed to create ${name}" >&2
  return 1
}

create_queue "video-encoding-staging-dlq"
create_queue "video-encoding-staging"

# Wire the DLQ + a sane retry policy onto the consumer. Idempotent.
echo "→ attaching DLQ to video-encoding-staging"
npx wrangler queues consumer add video-encoding-staging spooool-staging \
  --batch-size 10 \
  --max-retries 3 \
  --dead-letter-queue video-encoding-staging-dlq 2>&1 | tee /tmp/wrangler-queues.log || \
  grep -qiE 'already' /tmp/wrangler-queues.log

echo "✓ staging queue provisioning complete"
