import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const FORBIDDEN = [
  /\btransition\s*:/,
  /\banimation\s*:/,
  /@keyframes\b/,
  /className=["'`][^"'`]*\banimate-/,
  /className=["'`][^"'`]*\btransition-/,
  /className=["'`][^"'`]*\bduration-/,
  /className=["'`][^"'`]*\bease-/,
  /\bsetTimeout\s*\(/,
  /\bsetInterval\s*\(/,
  /\bDate\.now\s*\(/,
  /\bMath\.random\s*\(/,
];

export function containsForbiddenRemotionAnimationPattern(source) {
  return FORBIDDEN.some((pattern) => pattern.test(source));
}

function walk(dir) {
  const entries = fs.readdirSync(dir, { withFileTypes: true });
  return entries.flatMap((entry) => {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) return walk(full);
    return /\.tsx$/.test(entry.name) ? [full] : [];
  });
}

export function checkFiles(root = process.cwd()) {
  const targets = [
    path.join(root, 'container/render/remotion/SpoooolAnimation.tsx'),
    ...walk(path.join(root, 'container/render/remotion/animation')),
  ].filter((file) => fs.existsSync(file));
  const failures = targets.filter((file) => containsForbiddenRemotionAnimationPattern(fs.readFileSync(file, 'utf8')));
  return failures;
}

const isMain = process.argv[1] === fileURLToPath(import.meta.url);
if (isMain) {
  const failures = checkFiles();
  if (failures.length > 0) {
    console.error(`Forbidden Remotion animation patterns found:\n${failures.join('\n')}`);
    process.exit(1);
  }
}
