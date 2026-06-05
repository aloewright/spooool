#!/usr/bin/env node
// Guard rail: package.json must keep vendored file: tarballs and the Linux
// rolldown binding in optionalDependencies. fly-dev agents (and casual
// `npm install` on a stale branch) tend to revert these to registry semver
// and regenerate thousands of lockfile lines — often dropping studio features.
//
// Usage: node scripts/check-package-deps.mjs
// Exit 0 = OK, exit 1 = invariant violated (CI fails).

import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const repoRoot = join(fileURLToPath(import.meta.url), '..', '..');
const pkg = JSON.parse(readFileSync(join(repoRoot, 'package.json'), 'utf8'));

const REQUIRED_FILE_DEPS = {
  'buffer-image-size': 'file:buffer-image-size-0.6.4.tgz',
  entities: 'file:entities-7.0.1.tgz',
  'happy-dom': 'file:happy-dom-20.10.1.tgz',
  'whatwg-mimetype': 'file:whatwg-mimetype-3.0.0.tgz',
};

const REQUIRED_OPTIONAL_FILE_DEPS = {
  '@rolldown/binding-linux-x64-gnu':
    'file:rolldown-binding-linux-x64-gnu-1.0.0-rc.17.tgz',
};

const findings = [];

for (const [name, expected] of Object.entries(REQUIRED_FILE_DEPS)) {
  const actual = pkg.dependencies?.[name];
  if (actual !== expected) {
    findings.push(
      `dependencies["${name}"] must be "${expected}" (got ${JSON.stringify(actual)})`,
    );
  }
}

const rolldownInDeps = pkg.dependencies?.['@rolldown/binding-linux-x64-gnu'];
if (rolldownInDeps) {
  findings.push(
    '@rolldown/binding-linux-x64-gnu must not be in dependencies — use optionalDependencies (EBADPLATFORM on macOS)',
  );
}

for (const [name, expected] of Object.entries(REQUIRED_OPTIONAL_FILE_DEPS)) {
  const actual = pkg.optionalDependencies?.[name];
  if (actual !== expected) {
    findings.push(
      `optionalDependencies["${name}"] must be "${expected}" (got ${JSON.stringify(actual)})`,
    );
  }
}

if (findings.length > 0) {
  console.error('package.json dependency conventions violated:\n');
  for (const f of findings) console.error(`  - ${f}`);
  console.error(
    '\nSee scripts/regenerate-lockfile-linux.sh to refresh package-lock.json on Linux.',
  );
  process.exit(1);
}

console.log('package.json deps guard: vendored tarballs + optional rolldown binding OK');
