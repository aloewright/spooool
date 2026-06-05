import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

const forbidden = [
  /\btransition\s*:/,
  /\banimation\s*:/,
  /@keyframes\b/,
  /\banimate-/,
  /\btransition-/,
  /\bduration-/,
  /\bease-/,
  /\bsetTimeout\s*\(/,
  /\bsetInterval\s*\(/,
  /\bDate\.now\s*\(/,
  /\bMath\.random\s*\(/,
];

function files(dir: string): string[] {
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) return files(full);
    return /\.tsx$/.test(entry.name) ? [full] : [];
  });
}

describe('SpoooolAnimation Remotion constraints', () => {
  it('uses frame-driven Remotion animation only', () => {
    const root = path.resolve(__dirname);
    const targets = [path.join(root, 'SpoooolAnimation.tsx'), ...files(path.join(root, 'animation'))];
    const offenders = targets.filter((file) => forbidden.some((pattern) => pattern.test(fs.readFileSync(file, 'utf8'))));
    expect(offenders).toEqual([]);
  });
});
