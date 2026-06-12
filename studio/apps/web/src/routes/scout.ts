import { and, desc, eq, isNull } from "drizzle-orm";
import { drizzle } from "drizzle-orm/d1";
import { Hono } from "hono";
import { z } from "zod";
import { dataset_snapshots, market_findings, market_queries, projects } from "../db/schema";
import type { Env } from "../env";
import { type AuthVariables, requireUser } from "../middleware/auth";
import { latestDatasetSnapshot, refreshMarketDataset } from "../skills/scout/dataset";
import {
  type ScoutContext,
  readMarketRecords,
  synthesizeMarketFinding,
} from "../skills/scout/findings";

const querySchema = z.object({
  niche: z.string().trim().min(2).max(200),
  type: z.enum(["nonfiction", "fiction"]),
  project_id: z.string().uuid().optional(),
  params: z.record(z.string(), z.unknown()).optional().default({}),
});

export const scoutRoute = new Hono<{
  Bindings: Env;
  Variables: AuthVariables;
}>();

scoutRoute.use("*", requireUser);

scoutRoute.get("/queries", async (c) => {
  const user = c.get("user");
  const db = drizzle(c.env.DB);
  const rows = await db
    .select({
      query: market_queries,
      finding: market_findings,
      snapshot: dataset_snapshots,
    })
    .from(market_queries)
    .innerJoin(market_findings, eq(market_findings.query_id, market_queries.id))
    .innerJoin(dataset_snapshots, eq(dataset_snapshots.id, market_findings.dataset_snapshot_id))
    .where(eq(market_queries.user_id, user.id))
    .orderBy(desc(market_queries.created_at))
    .limit(20);

  return c.json({ items: rows.map(serializeScoutRow) });
});

scoutRoute.get("/projects/:projectId/findings", async (c) => {
  const user = c.get("user");
  const projectId = c.req.param("projectId");
  const db = drizzle(c.env.DB);
  const project = await getOwnedProject(db, user.id, projectId);
  if (!project) return c.json({ error: "not found" }, 404);

  const rows = await db
    .select({
      query: market_queries,
      finding: market_findings,
      snapshot: dataset_snapshots,
    })
    .from(market_queries)
    .innerJoin(market_findings, eq(market_findings.query_id, market_queries.id))
    .innerJoin(dataset_snapshots, eq(dataset_snapshots.id, market_findings.dataset_snapshot_id))
    .where(and(eq(market_queries.user_id, user.id), eq(market_queries.project_id, projectId)))
    .orderBy(desc(market_queries.created_at))
    .limit(10);

  return c.json({ items: rows.map(serializeScoutRow) });
});

scoutRoute.post("/queries", async (c) => {
  const user = c.get("user");
  const body = querySchema.parse(await c.req.json());
  const db = drizzle(c.env.DB);

  if (body.project_id) {
    const project = await getOwnedProject(db, user.id, body.project_id);
    if (!project) return c.json({ error: "project not found" }, 404);
  }

  const snapshot = await ensureDataset(c.env);
  const records = await readMarketRecords(c.env, snapshot.r2_key);
  const queryId = crypto.randomUUID();
  const findingId = crypto.randomUUID();
  const now = new Date();
  const finding = await synthesizeMarketFinding(c.env, {
    niche: body.niche,
    type: body.type,
    context: scoutContextFromParams(body.params),
    records,
    dataset: {
      snapshot_id: snapshot.id,
      week_iso: snapshot.week_iso,
      r2_key: snapshot.r2_key,
      source: snapshot.source,
    },
  });

  await db.insert(market_queries).values({
    id: queryId,
    user_id: user.id,
    project_id: body.project_id,
    niche: body.niche,
    type: body.type,
    params_json: body.params,
    created_at: now,
  });
  await db.insert(market_findings).values({
    id: findingId,
    query_id: queryId,
    dataset_snapshot_id: snapshot.id,
    summary_md: finding.summary_md,
    evidence_json: finding.evidence_json,
    created_at: now,
  });

  return c.json(
    {
      query: {
        id: queryId,
        user_id: user.id,
        project_id: body.project_id ?? null,
        niche: body.niche,
        type: body.type,
        params_json: body.params,
        created_at: now,
      },
      finding: {
        id: findingId,
        query_id: queryId,
        dataset_snapshot_id: snapshot.id,
        summary_md: finding.summary_md,
        evidence_json: finding.evidence_json,
        created_at: now,
      },
      snapshot,
    },
    201,
  );
});

async function ensureDataset(env: Env) {
  const latest = await latestDatasetSnapshot(env);
  if (latest) {
    const object = await env.R2.head(latest.r2_key);
    if (object) return latest;
  }
  await refreshMarketDataset(env);
  const refreshed = await latestDatasetSnapshot(env);
  if (!refreshed) throw new Error("market dataset refresh did not create a snapshot");
  return refreshed;
}

function scoutContextFromParams(params: Record<string, unknown>): ScoutContext {
  return {
    audience: typeof params.audience === "string" ? params.audience : undefined,
    angle: typeof params.angle === "string" ? params.angle : undefined,
  };
}

async function getOwnedProject(db: ReturnType<typeof drizzle>, userId: string, projectId: string) {
  const [project] = await db
    .select({ id: projects.id })
    .from(projects)
    .where(
      and(eq(projects.id, projectId), eq(projects.user_id, userId), isNull(projects.deleted_at)),
    )
    .limit(1);
  return project ?? null;
}

function serializeScoutRow(row: {
  query: typeof market_queries.$inferSelect;
  finding: typeof market_findings.$inferSelect;
  snapshot: typeof dataset_snapshots.$inferSelect;
}) {
  return {
    query: row.query,
    finding: row.finding,
    snapshot: {
      id: row.snapshot.id,
      week_iso: row.snapshot.week_iso,
      r2_key: row.snapshot.r2_key,
      source: row.snapshot.source,
      created_at: row.snapshot.created_at,
    },
  };
}
