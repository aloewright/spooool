import { spawn } from "node:child_process";
import { mkdir } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const scriptDir = dirname(fileURLToPath(import.meta.url));
const studioDir = resolve(scriptDir, "..");
const captureDir = resolve(scriptDir, "../../container/render/remotion/public/demo/screens");

await mkdir(captureDir, { recursive: true });

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

process.exit(exitCode);
