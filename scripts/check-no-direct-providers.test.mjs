// ALO-191: smoke test for the AI Gateway guard. Spawns the script with
// a tempdir staged as a fake repo root, asserts exit code + stderr.

import { describe, expect, it, beforeEach, afterEach } from 'vitest';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, cpSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = fileURLToPath(import.meta.url);
const repoRoot = join(here, '..', '..');
const scriptPath = join(repoRoot, 'scripts', 'check-no-direct-providers.mjs');

let work;

beforeEach(() => {
  work = mkdtempSync(join(tmpdir(), 'spooool-aig-'));
  // Stage the script under scripts/ inside the temp root and set up empty
  // src/, tests/, scripts/ dirs so the walker has something to traverse.
  mkdirSync(join(work, 'scripts'));
  mkdirSync(join(work, 'src'));
  mkdirSync(join(work, 'tests'));
  cpSync(scriptPath, join(work, 'scripts', 'check-no-direct-providers.mjs'));
});

afterEach(() => {
  rmSync(work, { recursive: true, force: true });
});

function run() {
  return spawnSync('node', ['scripts/check-no-direct-providers.mjs'], {
    cwd: work,
    encoding: 'utf8',
  });
}

describe('check-no-direct-providers', () => {
  it('passes on a clean tree', () => {
    writeFileSync(join(work, 'src', 'ok.ts'), 'export const x = 1;\n');
    const r = run();
    expect(r.status).toBe(0);
    expect(r.stdout).toMatch(/0 findings/);
  });

  it('fails on direct openai import', () => {
    writeFileSync(join(work, 'src', 'bad.ts'), "import OpenAI from 'openai';\n");
    const r = run();
    expect(r.status).toBe(1);
    expect(r.stderr).toMatch(/\[import\]/);
  });

  it('fails on hardcoded provider URL', () => {
    writeFileSync(
      join(work, 'src', 'bad.ts'),
      "fetch('https://api.openai.com/v1/chat/completions');\n",
    );
    const r = run();
    expect(r.status).toBe(1);
    expect(r.stderr).toMatch(/\[url\]/);
  });

  it('fails on hardcoded provider/model id', () => {
    writeFileSync(join(work, 'src', 'bad.ts'), 'const m = "anthropic/claude-3-5-sonnet";\n');
    const r = run();
    expect(r.status).toBe(1);
    expect(r.stderr).toMatch(/\[model-id\]/);
  });

  it('passes when AI Gateway URL is used', () => {
    writeFileSync(
      join(work, 'src', 'ok.ts'),
      "fetch('https://gateway.ai.cloudflare.com/v1/acc/x/compat/chat/completions');\n",
    );
    const r = run();
    expect(r.status).toBe(0);
  });

  it('skips *.test.ts files (they may import providers via mocks)', () => {
    writeFileSync(join(work, 'src', 'bad.test.ts'), "import OpenAI from 'openai';\n");
    const r = run();
    expect(r.status).toBe(0);
  });
});
