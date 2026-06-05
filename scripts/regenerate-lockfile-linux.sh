#!/usr/bin/env bash
# Regenerate package-lock.json on Linux so CI (ubuntu-latest) and local macOS
# installs agree. Optional native bindings resolve differently per OS; npm
# records that as dev vs devOptional metadata — committing a mac-generated
# lockfile causes noisy 80+ line diffs on every Linux npm install.
set -euo pipefail
cd "$(dirname "$0")/.."
docker run --rm \
  -v "$(pwd):/app" \
  -w /app \
  node:20-bookworm-slim \
  sh -c 'rm -rf node_modules && npm ci && npm install --package-lock-only'
echo "package-lock.json regenerated on Linux. Run: npm ci"
