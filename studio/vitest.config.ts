import { createRequire } from "node:module";
import path from "node:path";
import { defineConfig } from "vitest/config";

// The unit suite at studio/tests/unit imports production code from the
// `web` and `render-worker` workspaces, which in turn import hono / drizzle /
// aws-sdk. Under pnpm's default (isolated) node_modules layout those packages
// are NOT hoisted to studio/node_modules — they live under
// node_modules/.pnpm/<hash>/node_modules and are only symlinked into the
// node_modules of the workspace that declares them. A static alias to
// `${root}/node_modules/<pkg>` therefore 404s in CI (`pnpm install
// --frozen-lockfile` doesn't hoist), which is what broke the Studio · CI run.
//
// Resolve each package from the workspace that actually depends on it so the
// alias points at the real on-disk location regardless of the .pnpm hash.
// DEPS_PATH still overrides everything for environments that DO hoist (e.g.
// a flat node_modules); when set we keep the old behaviour.
const explicitDeps = process.env.DEPS_PATH;

const requireFromWeb = createRequire(`${path.resolve(__dirname, "apps/web")}/`);
const requireFromRenderWorker = createRequire(
  `${path.resolve(__dirname, "services/render-worker")}/`,
);

function packageDir(req: NodeRequire, name: string): string {
  // Resolve the package's main entry, then trim back to the package root
  // (the dir holding its package.json). Works for scoped names too.
  const main = req.resolve(name);
  const marker = `${path.sep}node_modules${path.sep}${name.split("/").join(path.sep)}`;
  const idx = main.lastIndexOf(marker);
  if (idx === -1) {
    throw new Error(`Could not locate package root for ${name} from ${main}`);
  }
  return main.slice(0, idx + marker.length);
}

function aliasFor(name: string, req: NodeRequire): string {
  if (explicitDeps) return `${explicitDeps}/${name}`;
  return packageDir(req, name);
}

export default defineConfig({
  resolve: {
    alias: {
      hono: aliasFor("hono", requireFromWeb),
      "drizzle-orm": aliasFor("drizzle-orm", requireFromWeb),
      "@aws-sdk/client-s3": aliasFor("@aws-sdk/client-s3", requireFromRenderWorker),
      "@hono/node-server": aliasFor("@hono/node-server", requireFromRenderWorker),
    },
  },
  test: {
    include: ["tests/unit/**/*.test.ts"],
    environment: "node",
  },
});
