#!/usr/bin/env node
// ALO-166: programmatic Doppler secrets sync. Replaces the `doppler run --`
// CLI wrapper in CI so the deploy machine doesn't need the Doppler binary
// installed — only a service token that this script uses against the v3
// REST API directly.
//
// Subcommands:
//
//   sync-worker-secrets [--env=<staging|production>]
//     Fetches all non-VITE / non-CLOUDFLARE / non-DOPPLER secrets from
//     Doppler and uploads them to the worker via `wrangler secret bulk`.
//     Idempotent — safe to run on every deploy. The --env flag selects
//     the wrangler environment (omit for the default top-level env).
//
//   write-build-env [--out=.env.production.local]
//     Writes every VITE_* secret to a dotenv file Vite can pick up at
//     build time. The file is overwritten each invocation; add it to
//     .gitignore (already there).
//
//   print-cloudflare-env
//     Prints `export NAME=value` lines for CLOUDFLARE_ACCOUNT_ID +
//     CLOUDFLARE_API_TOKEN. Wrap in `eval "$(...)"` so the wrangler
//     invocation in the same shell sees them.
//
//   dump [--filter=PREFIX]
//     Prints the fetched-secret keys (NOT values). Useful for verifying
//     a service token resolves the right config without leaking anything
//     into CI logs.
//
// Required env:
//   DOPPLER_TOKEN          service token scoped to the right project+config
//                          (currently `quickapp/<env>`; see doppler.yaml).
//                          Service tokens are config-scoped, so the script
//                          doesn't need DOPPLER_PROJECT / DOPPLER_CONFIG.
//
// Exit codes:
//   0  success
//   1  bad arguments / unknown subcommand
//   2  Doppler API error (non-2xx)
//   3  child-process failure (wrangler / shell)

import { spawnSync } from 'node:child_process';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const DOPPLER_API = 'https://api.doppler.com/v3/configs/config/secrets/download?format=json';

// Keys the script never forwards to the worker — the worker doesn't need
// them and forwarding leaks our deploy credentials into the runtime.
export const NEVER_SYNC_TO_WORKER = new Set([
  'CLOUDFLARE_API_TOKEN',
  'CLOUDFLARE_ACCOUNT_ID',
  'DOPPLER_TOKEN',
  'DOPPLER_PROJECT',
  'DOPPLER_CONFIG',
  'DOPPLER_ENVIRONMENT',
]);

export function parseArgs(argv) {
  const [, , subcommand, ...rest] = argv;
  const flags = {};
  for (const arg of rest) {
    const m = arg.match(/^--([^=]+)(?:=(.*))?$/);
    if (m) flags[m[1]] = m[2] ?? true;
  }
  return { subcommand, flags };
}

async function fetchSecrets() {
  const token = process.env.DOPPLER_TOKEN;
  if (!token) {
    console.error('error: DOPPLER_TOKEN is required (service token scoped to the target config).');
    process.exit(1);
  }
  const res = await fetch(DOPPLER_API, {
    headers: {
      // Doppler accepts `api-key: <token>` (legacy) and Bearer; use the
      // documented v3 header.
      Accept: 'application/json',
      Authorization: `Bearer ${token}`,
    },
  });
  if (!res.ok) {
    const body = await res.text().catch(() => '');
    console.error(`error: Doppler API ${res.status} ${res.statusText}`);
    if (body) console.error(body);
    process.exit(2);
  }
  // format=json returns a flat { KEY: "value", ... } object.
  return /** @type {Record<string, string>} */ (await res.json());
}

export function partition(secrets) {
  const worker = {};
  const vite = {};
  const cloudflare = {};
  for (const [key, raw] of Object.entries(secrets)) {
    const value = String(raw ?? '');
    if (NEVER_SYNC_TO_WORKER.has(key)) {
      if (key === 'CLOUDFLARE_API_TOKEN' || key === 'CLOUDFLARE_ACCOUNT_ID') {
        cloudflare[key] = value;
      }
      continue;
    }
    if (key.startsWith('VITE_')) {
      vite[key] = value;
      continue;
    }
    worker[key] = value;
  }
  return { worker, vite, cloudflare };
}

// Cloudflare's secrets-bulk API rejects more than 100 secrets per request
// (error code 100160). This shared Doppler config carries far more (200+), so
// the upload must be chunked. 90 leaves headroom under the hard limit.
export const BULK_SECRET_LIMIT = 90;

export function chunk(items, size) {
  const out = [];
  for (let i = 0; i < items.length; i += size) out.push(items.slice(i, i + size));
  return out;
}

async function syncWorkerSecrets(flags) {
  const secrets = await fetchSecrets();
  const { worker } = partition(secrets);
  const keys = Object.keys(worker);
  if (keys.length === 0) {
    console.log('no worker secrets to sync (only VITE_* / Cloudflare creds in this config).');
    return;
  }

  // wrangler secret bulk reads JSON: { name: value }. We split into batches of
  // <=BULK_SECRET_LIMIT because the Cloudflare API caps secrets-bulk at 100 per
  // request. `secret bulk` merges (it never deletes unlisted secrets), so
  // sequential batches accumulate into the same worker safely.
  const dir = mkdtempSync(join(tmpdir(), 'doppler-sync-'));
  const batches = chunk(keys, BULK_SECRET_LIMIT);
  console.log(
    `uploading ${keys.length} secret(s) to wrangler in ${batches.length} batch(es) of <=${BULK_SECRET_LIMIT}:`,
    keys.join(', '),
  );

  for (let i = 0; i < batches.length; i += 1) {
    const batchKeys = batches[i];
    const payload = Object.fromEntries(batchKeys.map((key) => [key, worker[key]]));
    const file = join(dir, `secrets-${i}.json`);
    writeFileSync(file, JSON.stringify(payload), { mode: 0o600 });

    const args = ['wrangler', 'secret', 'bulk', file];
    if (flags.env) args.splice(2, 0, '--env', String(flags.env));
    console.log(`  batch ${i + 1}/${batches.length}: ${batchKeys.length} secret(s)`);
    const result = spawnSync('npx', args, { stdio: 'inherit' });
    if (result.status !== 0) {
      console.error(`error: wrangler secret bulk failed on batch ${i + 1}/${batches.length}`);
      process.exit(3);
    }
  }
}

async function writeBuildEnv(flags) {
  const secrets = await fetchSecrets();
  const { vite } = partition(secrets);
  const out = String(flags.out ?? '.env.production.local');
  const lines = Object.entries(vite).map(([k, v]) => `${k}=${quoteForDotenv(v)}`);
  writeFileSync(out, `${lines.join('\n')}\n`, { mode: 0o600 });
  console.log(`wrote ${lines.length} VITE_* secret(s) to ${out}`);
}

export function quoteForDotenv(value) {
  // dotenv expansion: wrap in double quotes and escape \ " $ to avoid
  // command-substitution surprises.
  if (!/[\s"'$\\]/.test(value)) return value;
  return `"${value.replace(/[\\"$]/g, (c) => `\\${c}`)}"`;
}

async function printCloudflareEnv() {
  const secrets = await fetchSecrets();
  const { cloudflare } = partition(secrets);
  const lines = Object.entries(cloudflare).map(
    ([k, v]) => `export ${k}=${shellQuote(v)}`,
  );
  process.stdout.write(`${lines.join('\n')}\n`);
}

export function shellQuote(value) {
  // Single-quote-safe shell quoting: replace ' with '\''
  return `'${String(value).replaceAll("'", "'\\''")}'`;
}

async function dump(flags) {
  const secrets = await fetchSecrets();
  const filter = flags.filter ? String(flags.filter) : '';
  const keys = Object.keys(secrets)
    .filter((k) => !filter || k.startsWith(filter))
    .sort();
  for (const k of keys) console.log(k);
  console.log(`---\n${keys.length} key(s)`);
}

async function main() {
  const { subcommand, flags } = parseArgs(process.argv);
  switch (subcommand) {
    case 'sync-worker-secrets':
      await syncWorkerSecrets(flags);
      break;
    case 'write-build-env':
      await writeBuildEnv(flags);
      break;
    case 'print-cloudflare-env':
      await printCloudflareEnv();
      break;
    case 'dump':
      await dump(flags);
      break;
    default:
      console.error(
        'usage: scripts/sync-doppler-secrets.mjs <sync-worker-secrets|write-build-env|print-cloudflare-env|dump> [--flag=value]',
      );
      process.exit(1);
  }
}

// Only invoke main() when executed as a script, not when imported by tests.
// import.meta.url comparison is the standard ESM pattern for this guard.
const invokedDirectly = import.meta.url === `file://${process.argv[1]}`;
if (invokedDirectly) {
  main().catch((err) => {
    console.error('error:', err instanceof Error ? err.message : String(err));
    process.exit(2);
  });
}
