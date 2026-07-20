import * as Sentry from "@sentry/cloudflare";
import { routeAgentRequest } from "agents";
import { Hono } from "hono";
import { authBaseFromRequest, createAuth } from "./auth";
import { RenderWorkerContainer } from "./containers/render-worker";
import type { Env } from "./env";
import { resolveSessionUser } from "./middleware/auth";
import { errorHandler } from "./middleware/error";
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
import { APP_BASE_PREFIX, detectAppBase, rewriteHtmlBase } from "./shared/app-base";
import { refreshMarketDataset } from "./skills/scout/dataset";
import { AudiobookMasteringWorkflow } from "./workflows/audiobook-mastering";
import { BookExportWorkflow } from "./workflows/book-export";
import { GtmBriefWorkflow } from "./workflows/gtm-brief";

export { BookProjectAgent } from "./agents/aloysius";
export { RenderWorkerContainer };
export { BookExportWorkflow };
export { AudiobookMasteringWorkflow };
export { GtmBriefWorkflow };

const app = new Hono<{ Bindings: Env }>();

app.onError((err, c) => {
  const e = err as Error;
  const code = e.name === "BudgetExceeded" ? 402 : e.name === "Unauthorized" ? 401 : 500;
  console.error("error", e.name, e.message);
  if (e.name !== "Unauthorized" && e.name !== "BudgetExceeded") {
    Sentry.captureException(e);
  }
  return c.json({ error: { code: e.name, message: e.message } }, code);
});

app.route("/api/v1/health", healthRoute);

app.get("/api/v1/session", async (c) => {
  const user = await resolveSessionUser(c);
  return c.json({ user });
});

// Intercept Better Auth's error endpoint so we can show the error to the user
app.get("/api/auth/error", (c) => {
  const url = new URL(c.req.url);
  const err = url.searchParams.get("error") ?? "unknown";
  console.error(`[auth] /api/auth/error hit: ${err}`);
  Sentry.captureMessage(`better-auth /api/auth/error: ${err}`, {
    level: "error",
    tags: { component: "better-auth-error-page", error: err },
  });
  const base = c.req.header("x-app-base") ?? "";
  return c.redirect(`${base}/sign-in?error=${encodeURIComponent(err)}`);
});

app.on(["GET", "POST"], "/api/auth/*", async (c) => {
  const url = new URL(c.req.url);
  // When serving via spooool.com/studio, OAuth redirect URIs and callback
  // links must carry that origin + prefix. Better Auth routes against the
  // path in its baseURL, so hand it the original (unstripped) URL too.
  const authBase = authBaseFromRequest(c.req.raw);
  const auth = createAuth(c.env, authBase);
  const base = authBase.prefix;
  const authRequest = base
    ? new Request(new URL(`${base}${url.pathname}${url.search}`, url.origin), c.req.raw)
    : c.req.raw;
  console.log(`[auth] ${c.req.method} ${url.pathname}${url.search}`);
  const cookieNames = (c.req.header("cookie") ?? "")
    .split(";")
    .map((part) => part.split("=")[0]?.trim())
    .filter(Boolean);
  console.log(`[auth] cookies: ${cookieNames.join(", ") || "(none)"}`);
  try {
    const res = await auth.handler(authRequest);
    const loc = res.headers.get("location") ?? "";
    console.log(`[auth] response: ${res.status} ${loc}`);
    const setCookieNames = (res.headers.getSetCookie?.() ?? [])
      .map((v) => v.split("=")[0])
      .filter(Boolean);
    if (setCookieNames.length > 0) console.log(`[auth] set-cookie: ${setCookieNames.join(", ")}`);
    // Capture Better Auth error redirects to Sentry with full context
    if (loc.includes("/api/auth/error") || loc.includes("error=")) {
      const errMatch = loc.match(/[?&]error=([^&]+)/);
      const betterAuthError = errMatch ? decodeURIComponent(errMatch[1]) : "unknown";
      console.error(`[auth] Better Auth ERROR: ${betterAuthError} (path: ${url.pathname})`);
      Sentry.captureMessage(`better-auth error: ${betterAuthError}`, {
        level: "error",
        tags: { component: "better-auth", path: url.pathname, betterAuthError },
        extra: { fullLocation: loc, requestUrl: c.req.url, method: c.req.method },
      });
    }
    return res;
  } catch (err) {
    const e = err as Error;
    console.error(`[auth] ERROR ${e.name}: ${e.message}\n${e.stack}`);
    Sentry.captureException(e, { tags: { component: "auth-handler", path: url.pathname } });
    throw err;
  }
});

app.get("/api/v1/debug-session", async (c) => {
  const auth = createAuth(c.env, authBaseFromRequest(c.req.raw));
  const session = await auth.api.getSession({ headers: c.req.raw.headers });
  const cookies = c.req.header("cookie") ?? "(none)";
  return c.json({ session, cookieHeader: cookies.slice(0, 300) });
});

app.route("/api/v1/projects", projectsRoute);
app.route("/api/v1/blogs", blogsRoute);
app.route("/api/v1/scripts", scriptsRoute);
app.route("/api/v1/chapters", chaptersRoute);
app.route("/api/v1/voices", voicesRoute);
app.route("/api/v1/account", accountRoute);
app.route("/api/v1/scout", scoutRoute);
app.route("/api/v1/compose", composeRoute);
app.route("/api/v1/admin", adminRoute);

app.all("/agents/*", async (c) => {
  const res = await routeAgentRequest(c.req.raw, c.env);
  return res ?? c.text("not found", 404);
});

// Delegate all unmatched routes to the ASSETS binding so the SPA handles
// them. Prefixed requests get the built HTML's root-absolute asset URLs
// rebased so the browser fetches them back through the prefix.
app.get("*", async (c) => {
  const res = await c.env.ASSETS.fetch(c.req.raw);
  const base = c.req.header("x-app-base");
  if (!base || !res.headers.get("content-type")?.includes("text/html")) return res;
  const headers = new Headers(res.headers);
  headers.delete("content-length");
  return new Response(rewriteHtmlBase(await res.text(), base), {
    status: res.status,
    statusText: res.statusText,
    headers,
  });
});

// spooool.com/studio* routes here (see wrangler.jsonc). The app is built for
// root paths, so strip the /studio prefix before routing and record it in a
// header for the handlers that emit absolute URLs (auth, HTML rebasing).
// run_worker_first in wrangler.jsonc keeps prefixed requests out of the
// edge asset layer so this rewrite always runs.
function stripAppBasePrefix(request: Request): Request {
  const url = new URL(request.url);
  const base = detectAppBase(url.pathname);
  if (!base) {
    if (!request.headers.has("x-app-base")) return request;
    // Never trust the marker header from the client.
    const headers = new Headers(request.headers);
    headers.delete("x-app-base");
    return new Request(request, { headers });
  }
  url.pathname = url.pathname.slice(APP_BASE_PREFIX.length) || "/";
  const headers = new Headers(request.headers);
  headers.set("x-app-base", base);
  return new Request(url, new Request(request, { headers }));
}

// The studio used to mount at spooool.com/words; permanently redirect any
// legacy /words path to its /studio equivalent (subpath + query preserved).
// The spooool.com/words* zone route is kept alive in wrangler.jsonc solely
// to feed this redirect.
const LEGACY_BASE_PREFIX = "/words";
function legacyBaseRedirect(request: Request): Response | null {
  const url = new URL(request.url);
  if (url.pathname !== LEGACY_BASE_PREFIX && !url.pathname.startsWith(`${LEGACY_BASE_PREFIX}/`)) {
    return null;
  }
  url.pathname = `${APP_BASE_PREFIX}${url.pathname.slice(LEGACY_BASE_PREFIX.length)}`;
  return Response.redirect(url.toString(), 301);
}

const handler: ExportedHandler<Env> = {
  fetch: (request, env, ctx) =>
    legacyBaseRedirect(request) ?? app.fetch(stripAppBasePrefix(request), env, ctx),
  async scheduled(_event, env, ctx) {
    ctx.waitUntil(refreshMarketDataset(env));
  },
};

export default Sentry.withSentry(
  (env: Env) => ({
    dsn: (env as { SENTRY_DSN?: string }).SENTRY_DSN,
    tracesSampleRate: 0,
    sendDefaultPii: false,
    environment: env.ENV,
  }),
  handler,
);
