import { getContainer } from "@cloudflare/containers";
import type { Container } from "@cloudflare/containers";
import { Hono } from "hono";
import type { Env } from "../env";
import { latestDatasetSnapshot, refreshMarketDataset } from "../skills/scout/dataset";

export const healthRoute = new Hono<{ Bindings: Env }>();
const renderHealthContainerName = "render-worker-v2";

healthRoute.get("/", (c) => c.json({ ok: true, env: c.env.ENV, ts: Date.now() }));

healthRoute.get("/render", async (c) => {
  if (!c.env.RENDER_WORKER) return c.json({ ok: false, reason: "no binding (local dev)" }, 503);
  const binding = c.env.RENDER_WORKER as unknown as DurableObjectNamespace<Container>;
  const container = getContainer(binding, renderHealthContainerName);
  const res = await container.fetch("http://render/health", {
    headers: { "X-Internal-Token": c.env.RENDER_WORKER_INTERNAL_TOKEN ?? "" },
  });
  return c.json({ ok: res.ok, status: res.status });
});

healthRoute.get("/market-dataset", async (c) => {
  const latest = await latestDatasetSnapshot(c.env);
  return c.json({
    ok: Boolean(latest),
    latest: latest
      ? {
          week_iso: latest.week_iso,
          r2_key: latest.r2_key,
          source: latest.source,
          created_at: latest.created_at,
        }
      : null,
  });
});

healthRoute.post("/market-dataset/refresh", async (c) => {
  const result = await refreshMarketDataset(c.env);
  return c.json({ ok: true, ...result }, 201);
});
