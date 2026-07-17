import { and, asc, desc, eq, gte, isNull, lt } from "drizzle-orm";
import { drizzle } from "drizzle-orm/d1";
import { Hono } from "hono";
import { z } from "zod";
import { script_scenes, scripts } from "../db/schema";
import type { Env } from "../env";
import { type AuthVariables, requireUser } from "../middleware/auth";
import {
  SCRIPT_FORMAT_IDS,
  getScriptFormat,
  planScenesForStructure,
} from "../shared/script-formats";

const createSchema = z.object({
  title: z.string().min(1).max(200),
  format: z.enum(SCRIPT_FORMAT_IDS),
  logline: z.string().min(8).max(2_000),
  genre: z.string().max(200).optional(),
});

const patchSchema = z.object({
  title: z.string().min(1).max(200).optional(),
  logline: z.string().min(8).max(2_000).optional(),
});

const planSchema = z.object({
  structure: z.string().min(1).max(80),
  planned_scenes: z.number().int().min(1).max(52),
});

const patchSceneSchema = z.object({
  title: z.string().max(200).optional(),
  summary: z.string().max(2_000).optional(),
  // Loose BlockNote document shape: an array of blocks, each with a string
  // type. Rejecting anything else keeps a malformed payload from corrupting
  // the scene so the editor can no longer open it.
  draft_json: z
    .array(z.looseObject({ type: z.string() }))
    .max(5_000)
    .optional(),
  draft_md: z.string().max(200_000).optional(),
  draft_version: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER).optional(),
  status: z.enum(["planned", "drafting", "drafted"]).optional(),
});

export const scriptsRoute = new Hono<{
  Bindings: Env;
  Variables: AuthVariables;
}>();

scriptsRoute.use("*", requireUser);

const scriptSummaryColumns = {
  id: scripts.id,
  title: scripts.title,
  format: scripts.format,
  logline: scripts.logline,
  genre: scripts.genre,
  structure: scripts.structure,
  planned_scenes: scripts.planned_scenes,
  status: scripts.status,
  created_at: scripts.created_at,
  updated_at: scripts.updated_at,
  deleted_at: scripts.deleted_at,
};

scriptsRoute.get("/", async (c) => {
  const user = c.get("user");
  const db = drizzle(c.env.DB);
  const items = await db
    .select(scriptSummaryColumns)
    .from(scripts)
    .where(and(eq(scripts.user_id, user.id), isNull(scripts.deleted_at)))
    .orderBy(desc(scripts.updated_at));
  return c.json({ items });
});

scriptsRoute.get("/deleted/recent", async (c) => {
  const user = c.get("user");
  const db = drizzle(c.env.DB);
  const items = await db
    .select(scriptSummaryColumns)
    .from(scripts)
    .where(and(eq(scripts.user_id, user.id), gte(scripts.deleted_at, recentDeleteCutoff())))
    .orderBy(desc(scripts.deleted_at));
  return c.json({ items, retention_days: 30 });
});

scriptsRoute.post("/", async (c) => {
  const user = c.get("user");
  const body = createSchema.parse(await c.req.json());
  const id = crypto.randomUUID();
  const db = drizzle(c.env.DB);
  await db.insert(scripts).values({
    id,
    user_id: user.id,
    title: body.title,
    format: body.format,
    logline: body.logline,
    genre: body.genre ?? null,
  });
  return c.json({ id }, 201);
});

scriptsRoute.get("/:id", async (c) => {
  const user = c.get("user");
  const id = c.req.param("id");
  const db = drizzle(c.env.DB);
  const [s] = await db
    .select()
    .from(scripts)
    .where(and(eq(scripts.id, id), eq(scripts.user_id, user.id), isNull(scripts.deleted_at)))
    .limit(1);
  if (!s) return c.json({ error: "not found" }, 404);
  return c.json(s);
});

scriptsRoute.patch("/:id", async (c) => {
  const user = c.get("user");
  const id = c.req.param("id");
  const body = patchSchema.parse(await c.req.json());
  const db = drizzle(c.env.DB);
  const [s] = await db
    .select({ id: scripts.id })
    .from(scripts)
    .where(and(eq(scripts.id, id), eq(scripts.user_id, user.id), isNull(scripts.deleted_at)))
    .limit(1);
  if (!s) return c.json({ error: "not found" }, 404);

  await db
    .update(scripts)
    .set({ ...body, updated_at: new Date() })
    .where(and(eq(scripts.id, id), eq(scripts.user_id, user.id)));
  return c.json({ ok: true });
});

// Locks in the script's structure and planning threshold for the chosen
// format, then creates planned scene slots up to the threshold.
scriptsRoute.post("/:id/plan", async (c) => {
  const user = c.get("user");
  const id = c.req.param("id");
  const body = planSchema.parse(await c.req.json());
  const db = drizzle(c.env.DB);
  const [s] = await db
    .select()
    .from(scripts)
    .where(and(eq(scripts.id, id), eq(scripts.user_id, user.id), isNull(scripts.deleted_at)))
    .limit(1);
  if (!s) return c.json({ error: "not found" }, 404);

  const format = getScriptFormat(s.format);
  if (!format) return c.json({ error: "unknown script format" }, 400);
  if (!format.structures.some((st) => st.id === body.structure)) {
    return c.json({ error: `structure not available for ${format.shorthand}` }, 400);
  }
  if (body.planned_scenes < format.minScenes) {
    return c.json(
      {
        error: `${format.shorthand} plans at least ${format.minScenes} scene${
          format.minScenes === 1 ? "" : "s"
        } at a time`,
      },
      400,
    );
  }

  const existing = await db
    .select({ id: script_scenes.id })
    .from(script_scenes)
    .where(eq(script_scenes.script_id, id));
  if (body.planned_scenes < existing.length) {
    return c.json(
      { error: `cannot plan fewer than the ${existing.length} scenes already created` },
      400,
    );
  }
  // Structure beats pre-title the planned scenes; existing scenes are never
  // overwritten.
  const structureDef = format.structures.find((st) => st.id === body.structure);
  const beatPlan = planScenesForStructure(structureDef, body.planned_scenes);
  const created: (typeof script_scenes.$inferInsert)[] = [];
  for (let ordinal = existing.length + 1; ordinal <= body.planned_scenes; ordinal++) {
    const beat = beatPlan[ordinal - 1];
    created.push({
      id: crypto.randomUUID(),
      script_id: id,
      ordinal,
      title: beat?.title ?? "",
      summary: beat?.summary ?? "",
    });
  }
  // D1 caps bound parameters per query, so a full Save the Cat plan (15
  // scenes) can't land in a single multi-row insert — batch it.
  for (let i = 0; i < created.length; i += 10) {
    await db.insert(script_scenes).values(created.slice(i, i + 10));
  }

  await db
    .update(scripts)
    .set({
      structure: body.structure,
      planned_scenes: body.planned_scenes,
      status: "planning",
      updated_at: new Date(),
    })
    .where(and(eq(scripts.id, id), eq(scripts.user_id, user.id)));
  return c.json({ ok: true, scenes_created: created.length });
});

scriptsRoute.get("/:id/scenes", async (c) => {
  const user = c.get("user");
  const id = c.req.param("id");
  const db = drizzle(c.env.DB);
  const [s] = await db
    .select({ id: scripts.id })
    .from(scripts)
    .where(and(eq(scripts.id, id), eq(scripts.user_id, user.id), isNull(scripts.deleted_at)))
    .limit(1);
  if (!s) return c.json({ error: "not found" }, 404);
  const items = await db
    .select()
    .from(script_scenes)
    .where(eq(script_scenes.script_id, id))
    .orderBy(asc(script_scenes.ordinal));
  return c.json({ items });
});

scriptsRoute.get("/:id/scenes/:sceneId", async (c) => {
  const user = c.get("user");
  const id = c.req.param("id");
  const sceneId = c.req.param("sceneId");
  const db = drizzle(c.env.DB);
  const [s] = await db
    .select({ id: scripts.id })
    .from(scripts)
    .where(and(eq(scripts.id, id), eq(scripts.user_id, user.id), isNull(scripts.deleted_at)))
    .limit(1);
  if (!s) return c.json({ error: "not found" }, 404);
  const [scene] = await db
    .select()
    .from(script_scenes)
    .where(and(eq(script_scenes.id, sceneId), eq(script_scenes.script_id, id)))
    .limit(1);
  if (!scene) return c.json({ error: "scene not found" }, 404);
  return c.json(scene);
});

scriptsRoute.patch("/:id/scenes/:sceneId", async (c) => {
  const user = c.get("user");
  const id = c.req.param("id");
  const sceneId = c.req.param("sceneId");
  const body = patchSceneSchema.parse(await c.req.json());
  const db = drizzle(c.env.DB);
  const [s] = await db
    .select({ id: scripts.id })
    .from(scripts)
    .where(and(eq(scripts.id, id), eq(scripts.user_id, user.id), isNull(scripts.deleted_at)))
    .limit(1);
  if (!s) return c.json({ error: "not found" }, 404);
  const [scene] = await db
    .select({
      id: script_scenes.id,
      status: script_scenes.status,
      draftVersion: script_scenes.draft_version,
    })
    .from(script_scenes)
    .where(and(eq(script_scenes.id, sceneId), eq(script_scenes.script_id, id)))
    .limit(1);
  if (!scene) return c.json({ error: "scene not found" }, 404);

  const hasDraftUpdate = body.draft_json !== undefined || body.draft_md !== undefined;
  if (hasDraftUpdate && body.draft_version === undefined) {
    return c.json({ error: "draft_version is required for draft updates" }, 400);
  }

  // First draft content promotes a planned scene to drafting. Done here (not
  // in the client autosave) so a delayed save can never downgrade a status
  // the user set explicitly in the meantime.
  const { draft_version: draftVersion, ...patch } = body;
  const values = { ...patch, updated_at: new Date() };
  if (
    values.status === undefined &&
    scene.status === "planned" &&
    body.draft_md !== undefined &&
    body.draft_md.trim().length > 0
  ) {
    values.status = "drafting";
  }

  if (!hasDraftUpdate) {
    await db.update(script_scenes).set(values).where(eq(script_scenes.id, sceneId));
    return c.json({ ok: true, draft_version: scene.draftVersion });
  }

  const [updated] = await db
    .update(script_scenes)
    .set({ ...values, draft_version: draftVersion })
    .where(
      and(eq(script_scenes.id, sceneId), lt(script_scenes.draft_version, draftVersion as number)),
    )
    .returning({ draft_version: script_scenes.draft_version });
  if (!updated) {
    const [current] = await db
      .select({ draft_version: script_scenes.draft_version })
      .from(script_scenes)
      .where(eq(script_scenes.id, sceneId))
      .limit(1);
    return c.json({ error: "stale draft", draft_version: current?.draft_version ?? 0 }, 409);
  }
  return c.json({ ok: true, draft_version: updated.draft_version });
});

scriptsRoute.delete("/:id", async (c) => {
  const user = c.get("user");
  const id = c.req.param("id");
  const db = drizzle(c.env.DB);
  await db
    .update(scripts)
    .set({ deleted_at: new Date() })
    .where(and(eq(scripts.id, id), eq(scripts.user_id, user.id)));
  return new Response(null, { status: 204 });
});

scriptsRoute.post("/:id/restore", async (c) => {
  const user = c.get("user");
  const id = c.req.param("id");
  const db = drizzle(c.env.DB);
  const [s] = await db
    .select({ id: scripts.id })
    .from(scripts)
    .where(
      and(
        eq(scripts.id, id),
        eq(scripts.user_id, user.id),
        gte(scripts.deleted_at, recentDeleteCutoff()),
      ),
    )
    .limit(1);
  if (!s) return c.json({ error: "deleted script not found" }, 404);

  await db
    .update(scripts)
    .set({ deleted_at: null, updated_at: new Date() })
    .where(and(eq(scripts.id, id), eq(scripts.user_id, user.id)));
  return c.json({ ok: true });
});

function recentDeleteCutoff() {
  return new Date(Date.now() - 30 * 24 * 60 * 60 * 1000);
}
