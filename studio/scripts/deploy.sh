#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")/.."

# All wrangler invocations run under `doppler run` so wrangler picks up
# CLOUDFLARE_API_KEY + CLOUDFLARE_EMAIL from Doppler (project=quickapp,
# config=dev) instead of falling back to OAuth and prompting a browser
# sign-in. Override DOPPLER_PROJECT / DOPPLER_CONFIG to deploy from a
# different secret set.
DOPPLER_PROJECT="${DOPPLER_PROJECT:-quickapp}"
DOPPLER_CONFIG="${DOPPLER_CONFIG:-dev}"

# Build produces dist/client/bookgenerators_web/wrangler.json — deploy from there
# so the generated relative asset path ("../client") is correct.
( cd apps/web && pnpm build )
( cd apps/web && doppler run --project "$DOPPLER_PROJECT" --config "$DOPPLER_CONFIG" -- \
    pnpm exec wrangler --config dist/client/bookgenerators_web/wrangler.json deploy )
echo "deployed."
