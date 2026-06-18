// Studio content-hub backend, merged into the single spooool worker.
//
// Demoted from a standalone worker entry to a module: it exports `hubRoutes`
// (the Hono sub-app mounted by src/workers/index.ts) plus the Durable Object
// container and Workflow classes the merged worker re-exports, and the
// `refreshMarketDataset` cron task.
//
// Dropped vs the old `editor` worker (now owned by the merged spooool worker):
//   - studio's own Better Auth (/api/auth/*, /api/v1/debug-session) — the hub
//     authenticates with spooool's session (see middleware/auth.ts);
//   - the /agents/* endpoint + ALOYSIUS BookProjectAgent — deferred to
//     sub-project #3 (the `agents` SDK peer-depends on React 19);
//   - the ASSETS/SPA fallback and the /studio prefix + legacy /words handling —
//     the merged worker owns assets and routing.
//
// See docs/superpowers/specs/2026-06-15-studio-single-worker-merge-design.md.

import { Hono } from "hono";
import type { Env } from "./env";
import type { AuthVariables } from "./middleware/auth";
import { resolveSessionUser } from "./middleware/auth";
import { accountRoute } from "./routes/account";
import { adminRoute } from "./routes/admin";
import { blogsRoute } from "./routes/blogs";
import { chaptersRoute } from "./routes/chapters";
import { composeRoute } from "./routes/compose";
import { healthRoute } from "./routes/health";
import { projectsRoute } from "./routes/projects";
import { scoutRoute } from "./routes/scout";
import { scriptsRoute } from "./routes/scripts";
import { voicesRoute } from "./routes/voices";

export { RenderWorkerContainer } from "./containers/render-worker";
export { BookExportWorkflow } from "./workflows/book-export";
export { AudiobookMasteringWorkflow } from "./workflows/audiobook-mastering";
export { GtmBriefWorkflow } from "./workflows/gtm-brief";
export { refreshMarketDataset } from "./skills/scout/dataset";
export type { Env as HubEnv } from "./env";

export const hubRoutes = new Hono<{ Bindings: Env; Variables: AuthVariables }>();

hubRoutes.onError((err, c) => {
  const e = err as Error;
  const code =
    e.name === "BudgetExceeded"
      ? 402
      : e.name === "Unauthorized"
        ? 401
        : e.name === "Forbidden"
          ? 403
          : 500;
  console.error("[hub] error", e.name, e.message);
  return c.json({ error: { code: e.name, message: e.message } }, code);
});

hubRoutes.route("/api/v1/health", healthRoute);

hubRoutes.get("/api/v1/session", async (c) => {
  const user = await resolveSessionUser(c);
  return c.json({ user });
});

hubRoutes.route("/api/v1/projects", projectsRoute);
hubRoutes.route("/api/v1/blogs", blogsRoute);
hubRoutes.route("/api/v1/scripts", scriptsRoute);
hubRoutes.route("/api/v1/chapters", chaptersRoute);
hubRoutes.route("/api/v1/voices", voicesRoute);
hubRoutes.route("/api/v1/account", accountRoute);
hubRoutes.route("/api/v1/scout", scoutRoute);
hubRoutes.route("/api/v1/compose", composeRoute);
hubRoutes.route("/api/v1/admin", adminRoute);
