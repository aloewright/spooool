import { spawn } from "node:child_process";
import { mkdir, readdir, rm, stat } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { getPngCaptureNames } from "./capture-demo-utils.mjs";

const scriptDir = dirname(fileURLToPath(import.meta.url));
const studioDir = resolve(scriptDir, "..");
const captureDir = resolve(scriptDir, "../../container/render/remotion/public/demo/screens");
const expectedCaptureNames = [
  "studio-home.png",
  "studio-compose.png",
  "studio-outline.png",
  "studio-editor.png",
  "studio-book.png",
  "studio-publish.png",
].sort();

await mkdir(captureDir, { recursive: true });
await Promise.all(
  getPngCaptureNames(await readdir(captureDir)).map((name) => rm(resolve(captureDir, name))),
);

const exitCode = await new Promise((resolveExit, reject) => {
  const child = spawn(
    "pnpm",
    [
      "exec",
      "playwright",
      "test",
      "tests/e2e/demo-capture.spec.ts",
      "--config",
      "tests/e2e/playwright.config.ts",
      "--workers=1",
    ],
    {
      cwd: studioDir,
      env: {
        ...process.env,
        DEMO_CAPTURE_DIR: captureDir,
        E2E_BASE_URL: "http://localhost:4190",
      },
      stdio: "inherit",
    },
  );

  child.once("error", reject);
  child.once("exit", (code) => resolveExit(code ?? 1));
});

if (exitCode !== 0) process.exit(exitCode);

const actualCaptureNames = getPngCaptureNames(await readdir(captureDir));
if (JSON.stringify(actualCaptureNames) !== JSON.stringify(expectedCaptureNames)) {
  throw new Error(
    `Expected only ${expectedCaptureNames.join(", ")}; found ${actualCaptureNames.join(", ")}`,
  );
}

for (const name of actualCaptureNames) {
  if ((await stat(resolve(captureDir, name))).size === 0) {
    throw new Error(`Capture is empty: ${name}`);
  }
}
