#!/usr/bin/env bash
# scripts/bootstrap.sh
# Idempotently provisions Cloudflare resources for bookgenerators-web
# and mirrors Doppler secrets to Wrangler.
#
# Usage:
#   CLOUDFLARE_API_KEY=xxx CLOUDFLARE_EMAIL=xxx \
#   DOPPLER_PROJECT=quickapp DOPPLER_CONFIG=dev \
#   ./scripts/bootstrap.sh
#
# Safe to re-run; existing resources are detected and reused.

set -euo pipefail

cd "$(dirname "$0")/.."

WORKER_DIR="apps/web"
WRANGLER_CONFIG="$WORKER_DIR/wrangler.jsonc"
NAME="bookgenerators"
DOPPLER_PROJECT="${DOPPLER_PROJECT:-quickapp}"
DOPPLER_CONFIG="${DOPPLER_CONFIG:-dev}"

W=(wrangler --config "$WRANGLER_CONFIG")

echo "==> Authenticating wrangler..."
"${W[@]}" whoami

echo "==> D1 database..."
D1_ID=$("${W[@]}" d1 list --json | jq -r ".[] | select(.name==\"$NAME\") | .uuid")
if [[ -z "$D1_ID" || "$D1_ID" == "null" ]]; then
  D1_ID=$("${W[@]}" d1 create "$NAME" --json | jq -r ".uuid")
  echo "    created D1 $D1_ID"
else
  echo "    reused D1 $D1_ID"
fi

echo "==> KV namespace..."
KV_ID=$("${W[@]}" kv namespace list --json | jq -r ".[] | select(.title==\"${NAME}-kv\") | .id")
if [[ -z "$KV_ID" || "$KV_ID" == "null" ]]; then
  KV_ID=$("${W[@]}" kv namespace create "${NAME}-kv" --json | jq -r ".id")
  echo "    created KV $KV_ID"
else
  echo "    reused KV $KV_ID"
fi

echo "==> R2 bucket..."
if ! "${W[@]}" r2 bucket list | grep -q "$NAME"; then
  "${W[@]}" r2 bucket create "$NAME"
  echo "    created R2 $NAME"
else
  echo "    reused R2 $NAME"
fi

echo "==> Patching wrangler.jsonc..."
node scripts/patch-wrangler.mjs "$WRANGLER_CONFIG" \
  "D1_ID=$D1_ID" \
  "KV_ID=$KV_ID"

echo "==> Generating BETTER_AUTH_SECRET..."
if ! "${W[@]}" secret list 2>/dev/null | grep -q BETTER_AUTH_SECRET; then
  SECRET=$(openssl rand -hex 32)
  echo "$SECRET" | "${W[@]}" secret put BETTER_AUTH_SECRET
fi

echo "==> Mirroring Doppler secrets to Wrangler..."
for KEY in AI_GATEWAY_BASE_URL AI_GATEWAY_TOKEN S3_ACCESS_KEY_ID S3_SECRET_ACCESS_KEY S3_ENDPOINT RENDER_WORKER_INTERNAL_TOKEN KEYRING_MASTER_KEY; do
  VAL=$(doppler secrets get "$KEY" --project "$DOPPLER_PROJECT" --config "$DOPPLER_CONFIG" --plain 2>/dev/null || echo "")
  if [[ -n "$VAL" ]]; then
    if ! "${W[@]}" secret list 2>/dev/null | grep -q "$KEY"; then
      echo "$VAL" | "${W[@]}" secret put "$KEY"
    else
      echo "    $KEY already set — skipping"
    fi
  else
    echo "    Doppler missing $KEY — skipping"
  fi
done

echo "==> Applying D1 migrations..."
( cd "$WORKER_DIR" && pnpm db:migrate:remote )

echo "==> Done. Run \`pnpm cf-typegen\` then \`pnpm dev\` (in $WORKER_DIR)."
