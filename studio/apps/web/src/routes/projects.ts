import { and, asc, desc, eq, gte, inArray, isNull, sql } from "drizzle-orm";
import { drizzle } from "drizzle-orm/d1";
import { Hono } from "hono";
import { z } from "zod";
import {
  chapters,
  chat_messages,
  gtm_briefs,
  outlines,
  projects,
  publisher_packs,
  render_jobs,
  sections,
  users,
  voices,
} from "../db/schema";
import type { Env } from "../env";
import { gateway } from "../lib/gateway";
import { decryptSecret } from "../lib/keyring";
import { type AuthVariables, requireUser } from "../middleware/auth";
import { generateOutlineWithAi } from "../skills/architect";
import { buildNarrationScript } from "../skills/publisher/narration";
import {
  type PublisherSeoPack,
  normalizePack,
  synthesizePublisherSeo,
  validatePublisherSeoPack,
} from "../skills/publisher/seo";
import {
  downloadableBookKinds,
  fullBookView,
  normalizeExportKinds,
} from "../workflows/book-export-helpers";
import { prepareGtmBriefInput } from "../workflows/gtm-brief";

const createSchema = z.object({
  title: z.string().min(1).max(200),
  type: z.enum(["nonfiction", "fiction"]),
  genre: z.string().max(500).optional(),
  logline: z.string().max(2_000).optional(),
  audience: z.array(z.string().min(1).max(80)).max(12).optional(),
  voice_styles: z.array(z.string().min(1).max(80)).max(12).optional(),
  target_word_count: z.number().int().min(5000).max(200000).optional(),
});

const patchSchema = z.object({
  voice_id: z.string().uuid().nullable().optional(),
});

const outlineSchema = z.object({
  framework: z.string().max(80).optional(),
  questionnaire: z.string().min(1).max(20_000),
  character_arcs: z
    .array(
      z.object({
        name: z.string().min(1).max(120),
        arc: z.string().min(1).max(80),
        position: z.string().max(500).default(""),
        sceneRole: z.string().max(500).optional(),
      }),
    )
    .max(12)
    .optional(),
  scene_plan: z
    .object({
      defaultCast: z.string().max(1000).optional(),
      miniStructure: z.string().max(1000).optional(),
    })
    .optional(),
  chapter_plan: z
    .array(
      z.object({
        ordinal: z.number().int().min(1).max(80),
        title: z.string().max(160).optional(),
        event: z.string().min(1).max(1200),
        purpose: z.string().max(800).optional(),
        pov: z.string().max(120).optional(),
        characters: z.string().max(500).optional(),
      }),
    )
    .max(80)
    .optional(),
});

const publisherPackSchema = z.object({
  title: z.string().min(1).max(200),
  subtitle: z.string().max(200).default(""),
  series_name: z.string().max(200).default(""),
  description_html: z.string().max(4000),
  keywords: z.array(z.string().min(1).max(50)).length(7),
  bisac: z.array(z.string().min(1).max(120)).length(2),
});

const auditionSchema = z.object({
  elevenlabs_voice_ids: z.array(z.string().trim().min(1).max(120)).min(1).max(3),
});

const exportSchema = z.object({
  formats: z
    .array(z.enum(["epub", "pdf", "kpf"]))
    .max(3)
    .optional(),
});

export const projectsRoute = new Hono<{
  Bindings: Env;
  Variables: AuthVariables;
}>();

projectsRoute.use("*", requireUser);

projectsRoute.get("/", async (c) => {
  const user = c.get("user");
  const db = drizzle(c.env.DB);
  const items = await db
    .select()
    .from(projects)
    .where(and(eq(projects.user_id, user.id), isNull(projects.deleted_at)))
    .orderBy(desc(projects.updated_at));
  return c.json({ items });
});

projectsRoute.get("/deleted/recent", async (c) => {
  const user = c.get("user");
  const db = drizzle(c.env.DB);
  const cutoff = recentDeleteCutoff();
  const items = await db
    .select()
    .from(projects)
    .where(and(eq(projects.user_id, user.id), gte(projects.deleted_at, cutoff)))
    .orderBy(desc(projects.deleted_at));
  return c.json({ items, retention_days: 30 });
});

projectsRoute.post("/", async (c) => {
  const user = c.get("user");
  const body = createSchema.parse(await c.req.json());
  const id = crypto.randomUUID();
  const db = drizzle(c.env.DB);
  await db.insert(projects).values({
    id,
    user_id: user.id,
    title: body.title,
    type: body.type,
    genre: body.genre,
    logline: body.logline ?? "",
    audience_json: body.audience ?? [],
    voice_styles_json: body.voice_styles ?? [],
    target_word_count: body.target_word_count ?? (body.type === "nonfiction" ? 50000 : 75000),
  });
  return c.json({ id }, 201);
});

projectsRoute.post("/:id/restore", async (c) => {
  const user = c.get("user");
  const id = c.req.param("id");
  const db = drizzle(c.env.DB);
  const [p] = await db
    .select({ id: projects.id })
    .from(projects)
    .where(
      and(
        eq(projects.id, id),
        eq(projects.user_id, user.id),
        gte(projects.deleted_at, recentDeleteCutoff()),
      ),
    )
    .limit(1);
  if (!p) return c.json({ error: "deleted book not found" }, 404);

  await db
    .update(projects)
    .set({ deleted_at: null, updated_at: new Date() })
    .where(and(eq(projects.id, id), eq(projects.user_id, user.id)));
  return c.json({ ok: true });
});

projectsRoute.get("/:id", async (c) => {
  const user = c.get("user");
  const id = c.req.param("id");
  const db = drizzle(c.env.DB);
  const [p] = await db
    .select()
    .from(projects)
    .where(and(eq(projects.id, id), eq(projects.user_id, user.id), isNull(projects.deleted_at)))
    .limit(1);
  if (!p) return c.json({ error: "not found" }, 404);
  return c.json(p);
});

projectsRoute.get("/:id/chat", async (c) => {
  const user = c.get("user");
  const id = c.req.param("id");
  const db = drizzle(c.env.DB);
  const [p] = await db
    .select({ id: projects.id })
    .from(projects)
    .where(and(eq(projects.id, id), eq(projects.user_id, user.id), isNull(projects.deleted_at)))
    .limit(1);
  if (!p) return c.json({ error: "not found" }, 404);
  const rows = await db
    .select()
    .from(chat_messages)
    .where(eq(chat_messages.project_id, id))
    .orderBy(asc(chat_messages.created_at))
    .limit(200);
  const items = rows
    .filter((r) => r.role === "user" || r.role === "assistant")
    .map((r) => ({
      role: r.role as "user" | "assistant",
      text: typeof r.content_json === "string" ? r.content_json : JSON.stringify(r.content_json),
    }));
  return c.json({ items });
});

projectsRoute.patch("/:id", async (c) => {
  const user = c.get("user");
  const id = c.req.param("id");
  const body = patchSchema.parse(await c.req.json());
  const db = drizzle(c.env.DB);

  const [p] = await db
    .select({ id: projects.id })
    .from(projects)
    .where(and(eq(projects.id, id), eq(projects.user_id, user.id), isNull(projects.deleted_at)))
    .limit(1);
  if (!p) return c.json({ error: "not found" }, 404);

  if (body.voice_id) {
    const [voice] = await db
      .select({ id: voices.id })
      .from(voices)
      .where(and(eq(voices.id, body.voice_id), eq(voices.user_id, user.id)))
      .limit(1);
    if (!voice) return c.json({ error: "voice not found" }, 404);
  }

  const values =
    body.voice_id === undefined
      ? { updated_at: new Date() }
      : {
          voice_id: body.voice_id,
          status: body.voice_id ? ("voice" as const) : ("concept" as const),
          updated_at: new Date(),
        };

  await db
    .update(projects)
    .set(values)
    .where(and(eq(projects.id, id), eq(projects.user_id, user.id)));

  return c.json({ ok: true });
});

projectsRoute.get("/:id/outline", async (c) => {
  const user = c.get("user");
  const id = c.req.param("id");
  const db = drizzle(c.env.DB);
  const [p] = await db
    .select({ id: projects.id })
    .from(projects)
    .where(and(eq(projects.id, id), eq(projects.user_id, user.id), isNull(projects.deleted_at)))
    .limit(1);
  if (!p) return c.json({ error: "not found" }, 404);

  const [outline] = await db
    .select()
    .from(outlines)
    .where(eq(outlines.project_id, id))
    .orderBy(desc(outlines.version))
    .limit(1);
  const chapterRows = await db
    .select()
    .from(chapters)
    .where(eq(chapters.project_id, id))
    .orderBy(asc(chapters.ordinal));
  return c.json({ outline: outline ?? null, chapters: chapterRows });
});

projectsRoute.get("/:id/publisher-pack", async (c) => {
  const user = c.get("user");
  const id = c.req.param("id");
  const db = drizzle(c.env.DB);
  const [p] = await db
    .select({ id: projects.id })
    .from(projects)
    .where(and(eq(projects.id, id), eq(projects.user_id, user.id), isNull(projects.deleted_at)))
    .limit(1);
  if (!p) return c.json({ error: "not found" }, 404);

  const [pack] = await db
    .select()
    .from(publisher_packs)
    .where(eq(publisher_packs.project_id, id))
    .orderBy(desc(publisher_packs.updated_at))
    .limit(1);

  return c.json({ pack: pack ? serializePublisherPack(pack) : null });
});

projectsRoute.post("/:id/publisher-pack/seo", async (c) => {
  const user = c.get("user");
  const id = c.req.param("id");
  const db = drizzle(c.env.DB);
  const [p] = await db
    .select()
    .from(projects)
    .where(and(eq(projects.id, id), eq(projects.user_id, user.id), isNull(projects.deleted_at)))
    .limit(1);
  if (!p) return c.json({ error: "not found" }, 404);

  const chapterRows = await db
    .select({
      title: chapters.title,
      summary: chapters.summary,
      draft_md: chapters.draft_md,
    })
    .from(chapters)
    .where(eq(chapters.project_id, id))
    .orderBy(asc(chapters.ordinal));

  if (chapterRows.length === 0) {
    return c.json({ error: "generate an outline before creating publisher metadata" }, 409);
  }

  const result = await synthesizePublisherSeo(c.env, {
    title: p.title,
    type: p.type,
    genre: p.genre,
    chapters: chapterRows,
  });
  const validationErrors = validatePublisherSeoPack(result.pack);
  if (validationErrors.length)
    return c.json({ error: { message: validationErrors.join(" ") } }, 422);

  const now = new Date();
  const packId = crypto.randomUUID();
  await db.insert(publisher_packs).values({
    id: packId,
    project_id: id,
    title: result.pack.title,
    subtitle: result.pack.subtitle,
    series_name: result.pack.series_name,
    description_html: result.pack.description_html,
    keywords_json: result.pack.keywords,
    bisac_json: result.pack.bisac,
    status: "draft",
    created_at: now,
    updated_at: now,
  });
  await db
    .update(projects)
    .set({ status: "publishing", updated_at: now })
    .where(eq(projects.id, id));

  return c.json(
    { pack: { id: packId, status: "draft", ...result.pack }, llm_response: result.llm_response },
    201,
  );
});

projectsRoute.patch("/:id/publisher-pack", async (c) => {
  const user = c.get("user");
  const id = c.req.param("id");
  const db = drizzle(c.env.DB);
  const [p] = await db
    .select({ id: projects.id, title: projects.title, type: projects.type, genre: projects.genre })
    .from(projects)
    .where(and(eq(projects.id, id), eq(projects.user_id, user.id), isNull(projects.deleted_at)))
    .limit(1);
  if (!p) return c.json({ error: "not found" }, 404);

  const body = publisherPackSchema.parse(await c.req.json());
  const pack = normalizePack(body, { title: p.title, type: p.type, genre: p.genre, chapters: [] });
  const validationErrors = validatePublisherSeoPack(pack);
  if (validationErrors.length)
    return c.json({ error: { message: validationErrors.join(" ") } }, 422);

  const [existing] = await db
    .select({ id: publisher_packs.id, status: publisher_packs.status })
    .from(publisher_packs)
    .where(eq(publisher_packs.project_id, id))
    .orderBy(desc(publisher_packs.updated_at))
    .limit(1);
  if (!existing) return c.json({ error: "publisher pack not found" }, 404);
  if (existing.status === "approved") return c.json({ error: "approved pack is locked" }, 409);

  await db
    .update(publisher_packs)
    .set({
      title: pack.title,
      subtitle: pack.subtitle,
      series_name: pack.series_name,
      description_html: pack.description_html,
      keywords_json: pack.keywords,
      bisac_json: pack.bisac,
      updated_at: new Date(),
    })
    .where(eq(publisher_packs.id, existing.id));

  return c.json({ pack: { id: existing.id, status: "draft", ...pack } });
});

projectsRoute.post("/:id/publisher-pack/approve", async (c) => {
  const user = c.get("user");
  const id = c.req.param("id");
  const db = drizzle(c.env.DB);
  const [p] = await db
    .select({ id: projects.id })
    .from(projects)
    .where(and(eq(projects.id, id), eq(projects.user_id, user.id), isNull(projects.deleted_at)))
    .limit(1);
  if (!p) return c.json({ error: "not found" }, 404);

  const [pack] = await db
    .select()
    .from(publisher_packs)
    .where(eq(publisher_packs.project_id, id))
    .orderBy(desc(publisher_packs.updated_at))
    .limit(1);
  if (!pack) return c.json({ error: "publisher pack not found" }, 404);

  const serialized = serializePublisherPack(pack);
  const validationErrors = validatePublisherSeoPack(serialized);
  if (validationErrors.length)
    return c.json({ error: { message: validationErrors.join(" ") } }, 422);

  await db
    .update(publisher_packs)
    .set({ status: "approved", updated_at: new Date() })
    .where(eq(publisher_packs.id, pack.id));

  return c.json({ pack: { ...serialized, status: "approved" } });
});

projectsRoute.get("/:id/book", async (c) => {
  const user = c.get("user");
  const id = c.req.param("id");
  const db = drizzle(c.env.DB);
  const [p] = await db
    .select({ id: projects.id, title: projects.title })
    .from(projects)
    .where(and(eq(projects.id, id), eq(projects.user_id, user.id), isNull(projects.deleted_at)))
    .limit(1);
  if (!p) return c.json({ error: "not found" }, 404);

  const chapterRows = await db
    .select({
      id: chapters.id,
      ordinal: chapters.ordinal,
      title: chapters.title,
      summary: chapters.summary,
      draft_md: chapters.draft_md,
    })
    .from(chapters)
    .where(eq(chapters.project_id, id))
    .orderBy(asc(chapters.ordinal));

  return c.json({
    project: p,
    book: fullBookView(p.title, chapterRows),
    export_formats: downloadableBookKinds,
  });
});

projectsRoute.post("/:id/tts", async (c) => {
  const user = c.get("user");
  const id = c.req.param("id");
  const db = drizzle(c.env.DB);
  const [p] = await db
    .select({ id: projects.id })
    .from(projects)
    .where(and(eq(projects.id, id), eq(projects.user_id, user.id), isNull(projects.deleted_at)))
    .limit(1);
  if (!p) return c.json({ error: "not found" }, 404);

  const chapterRows = await db
    .select({ id: chapters.id, draft_md: chapters.draft_md })
    .from(chapters)
    .where(eq(chapters.project_id, id))
    .orderBy(asc(chapters.ordinal));

  const drafted = chapterRows.find((row) => row.draft_md.trim().length > 0);
  if (!drafted) {
    return c.json({ error: { message: "No drafted content to read." } }, 400);
  }

  const text = drafted.draft_md.slice(0, 4000);
  const audio = await gateway.audioGen(c.env, {
    input: text,
    voice: "alloy",
    format: "mp3",
  });
  return new Response(audio, {
    headers: { "Content-Type": "audio/mpeg" },
  });
});

projectsRoute.get("/:id/export/jobs", async (c) => {
  const user = c.get("user");
  const id = c.req.param("id");
  const db = drizzle(c.env.DB);
  const [p] = await db
    .select({ id: projects.id })
    .from(projects)
    .where(and(eq(projects.id, id), eq(projects.user_id, user.id), isNull(projects.deleted_at)))
    .limit(1);
  if (!p) return c.json({ error: "not found" }, 404);

  const jobs = await db
    .select()
    .from(render_jobs)
    .where(eq(render_jobs.project_id, id))
    .orderBy(desc(render_jobs.started_at));
  return c.json({ items: jobs.map((job) => serializeRenderJob(id, job)) });
});

projectsRoute.post("/:id/export", async (c) => {
  const user = c.get("user");
  const id = c.req.param("id");
  const body = exportSchema.parse(await c.req.json().catch(() => ({})));
  if (!c.env.BOOK_EXPORT_WORKFLOW) {
    return c.json({ error: "book export workflow is not configured" }, 503);
  }

  const db = drizzle(c.env.DB);
  const [p] = await db
    .select({ id: projects.id })
    .from(projects)
    .where(and(eq(projects.id, id), eq(projects.user_id, user.id), isNull(projects.deleted_at)))
    .limit(1);
  if (!p) return c.json({ error: "not found" }, 404);

  const instanceId = `book-export-${id}-${Date.now()}`;
  await c.env.BOOK_EXPORT_WORKFLOW.create({
    id: instanceId,
    params: { projectId: id, userId: user.id, formats: normalizeExportKinds(body.formats) },
  });
  return c.json({ id: instanceId }, 202);
});

projectsRoute.get("/:id/export/:jobId/download", async (c) => {
  const user = c.get("user");
  const id = c.req.param("id");
  const jobId = c.req.param("jobId");
  const db = drizzle(c.env.DB);
  const [job] = await db
    .select({
      id: render_jobs.id,
      kind: render_jobs.kind,
      output_r2_key: render_jobs.output_r2_key,
      projectId: projects.id,
    })
    .from(render_jobs)
    .innerJoin(projects, eq(render_jobs.project_id, projects.id))
    .where(
      and(
        eq(render_jobs.id, jobId),
        eq(projects.id, id),
        eq(projects.user_id, user.id),
        isNull(projects.deleted_at),
      ),
    )
    .limit(1);
  if (!job?.output_r2_key) return c.json({ error: "download not found" }, 404);
  const object = await c.env.R2.get(job.output_r2_key);
  if (!object) return c.json({ error: "download not found" }, 404);
  return new Response(object.body, {
    headers: {
      "Content-Type": contentTypeForJob(job.kind),
      "Content-Disposition": `attachment; filename="${id}.${job.kind}"`,
    },
  });
});

projectsRoute.get("/:id/narration/auditions", async (c) => {
  const user = c.get("user");
  const id = c.req.param("id");
  const db = drizzle(c.env.DB);
  const [p] = await db
    .select({ id: projects.id })
    .from(projects)
    .where(and(eq(projects.id, id), eq(projects.user_id, user.id), isNull(projects.deleted_at)))
    .limit(1);
  if (!p) return c.json({ error: "not found" }, 404);

  const jobs = await db
    .select()
    .from(render_jobs)
    .where(and(eq(render_jobs.project_id, id), eq(render_jobs.kind, "narration")))
    .orderBy(desc(render_jobs.started_at));
  const approved = await c.env.KV.get(`narration:approved:${id}`, "json");
  return c.json({
    items: jobs.map((job) => serializeAudition(id, job)),
    approved,
  });
});

projectsRoute.post("/:id/narration/audition", async (c) => {
  const user = c.get("user");
  const id = c.req.param("id");
  const body = auditionSchema.parse(await c.req.json());
  const db = drizzle(c.env.DB);
  const [p] = await db
    .select({ id: projects.id })
    .from(projects)
    .where(and(eq(projects.id, id), eq(projects.user_id, user.id), isNull(projects.deleted_at)))
    .limit(1);
  if (!p) return c.json({ error: "not found" }, 404);

  const [keyRow] = await db
    .select({
      ciphertext: users.elevenlabs_key_ciphertext,
      iv: users.elevenlabs_key_iv,
    })
    .from(users)
    .where(eq(users.id, user.id))
    .limit(1);
  if (!keyRow?.ciphertext || !keyRow.iv) {
    return c.json({ error: { message: "save an ElevenLabs API key before auditioning" } }, 409);
  }

  const chapterRows = await db
    .select({
      title: chapters.title,
      summary: chapters.summary,
      draft_md: chapters.draft_md,
    })
    .from(chapters)
    .where(eq(chapters.project_id, id))
    .orderBy(asc(chapters.ordinal));
  if (!chapterRows.length) return c.json({ error: "generate an outline before auditioning" }, 409);

  const script = buildNarrationScript(chapterRows);
  if (!script.sampleText)
    return c.json({ error: "no manuscript text available for audition" }, 409);

  const apiKey = await decryptSecret(
    keyRow.ciphertext as ArrayBuffer | Uint8Array,
    keyRow.iv as ArrayBuffer | Uint8Array,
    c.env.KEYRING_MASTER_KEY,
  );
  const now = new Date();
  const jobs = [];
  for (const voiceId of body.elevenlabs_voice_ids) {
    const jobId = crypto.randomUUID();
    await db.insert(render_jobs).values({
      id: jobId,
      project_id: id,
      kind: "narration",
      status: "running",
      workflow_id: `audition:${voiceId}`,
      started_at: now,
    });
    try {
      const audio = await renderElevenLabsAudition(apiKey, voiceId, script.sampleText);
      const r2Key = `auditions/${id}/${voiceId}.mp3`;
      await c.env.R2.put(r2Key, audio, {
        httpMetadata: { contentType: "audio/mpeg" },
        customMetadata: {
          voice_id: voiceId,
          script_chunks: String(script.chunks.length),
        },
      });
      await db
        .update(render_jobs)
        .set({ status: "completed", output_r2_key: r2Key, completed_at: new Date() })
        .where(eq(render_jobs.id, jobId));
    } catch (error) {
      await db
        .update(render_jobs)
        .set({
          status: "failed",
          error: error instanceof Error ? error.message : "audition failed",
          completed_at: new Date(),
        })
        .where(eq(render_jobs.id, jobId));
    }
    const [job] = await db.select().from(render_jobs).where(eq(render_jobs.id, jobId)).limit(1);
    jobs.push(serializeAudition(id, job));
  }

  return c.json({ items: jobs, script: { chunks: script.chunks.length } }, 201);
});

projectsRoute.get("/:id/narration/auditions/:jobId/audio", async (c) => {
  const user = c.get("user");
  const id = c.req.param("id");
  const jobId = c.req.param("jobId");
  const db = drizzle(c.env.DB);
  const [job] = await db
    .select({
      id: render_jobs.id,
      output_r2_key: render_jobs.output_r2_key,
      projectId: projects.id,
    })
    .from(render_jobs)
    .innerJoin(projects, eq(render_jobs.project_id, projects.id))
    .where(
      and(
        eq(render_jobs.id, jobId),
        eq(render_jobs.kind, "narration"),
        eq(projects.id, id),
        eq(projects.user_id, user.id),
        isNull(projects.deleted_at),
      ),
    )
    .limit(1);
  if (!job?.output_r2_key) return c.json({ error: "audition not found" }, 404);
  const object = await c.env.R2.get(job.output_r2_key);
  if (!object) return c.json({ error: "audition not found" }, 404);
  return new Response(object.body, {
    headers: {
      "Content-Type": "audio/mpeg",
      "Content-Disposition": `inline; filename="${id}-audition.mp3"`,
    },
  });
});

projectsRoute.post("/:id/narration/auditions/:jobId/approve", async (c) => {
  const user = c.get("user");
  const id = c.req.param("id");
  const jobId = c.req.param("jobId");
  const db = drizzle(c.env.DB);
  const [job] = await db
    .select({
      id: render_jobs.id,
      status: render_jobs.status,
      workflow_id: render_jobs.workflow_id,
      output_r2_key: render_jobs.output_r2_key,
      projectId: projects.id,
    })
    .from(render_jobs)
    .innerJoin(projects, eq(render_jobs.project_id, projects.id))
    .where(
      and(
        eq(render_jobs.id, jobId),
        eq(render_jobs.kind, "narration"),
        eq(projects.id, id),
        eq(projects.user_id, user.id),
        isNull(projects.deleted_at),
      ),
    )
    .limit(1);
  if (!job || job.status !== "completed" || !job.output_r2_key) {
    return c.json({ error: "completed audition not found" }, 404);
  }
  const approval = {
    job_id: job.id,
    voice_id: voiceIdFromWorkflow(job.workflow_id),
    output_r2_key: job.output_r2_key,
    approved_at: new Date().toISOString(),
  };
  await c.env.KV.put(`narration:approved:${id}`, JSON.stringify(approval));
  return c.json({ approved: approval });
});

projectsRoute.post("/:id/audiobook", async (c) => {
  const user = c.get("user");
  const id = c.req.param("id");
  if (!c.env.AUDIOBOOK_MASTERING_WORKFLOW) {
    return c.json({ error: "audiobook mastering workflow is not configured" }, 503);
  }
  const db = drizzle(c.env.DB);
  const [p] = await db
    .select({ id: projects.id })
    .from(projects)
    .where(and(eq(projects.id, id), eq(projects.user_id, user.id), isNull(projects.deleted_at)))
    .limit(1);
  if (!p) return c.json({ error: "not found" }, 404);

  const approved = await c.env.KV.get(`narration:approved:${id}`, "json");
  if (!approved) return c.json({ error: "approve a narration audition before mastering" }, 409);

  const instanceId = `audiobook-master-${id}-${Date.now()}`;
  await c.env.AUDIOBOOK_MASTERING_WORKFLOW.create({
    id: instanceId,
    params: { projectId: id, userId: user.id },
  });
  return c.json({ id: instanceId }, 202);
});

projectsRoute.get("/:id/audiobook/jobs", async (c) => {
  const user = c.get("user");
  const id = c.req.param("id");
  const db = drizzle(c.env.DB);
  const [p] = await db
    .select({ id: projects.id })
    .from(projects)
    .where(and(eq(projects.id, id), eq(projects.user_id, user.id), isNull(projects.deleted_at)))
    .limit(1);
  if (!p) return c.json({ error: "not found" }, 404);
  const jobs = await db
    .select()
    .from(render_jobs)
    .where(
      and(eq(render_jobs.project_id, id), sql`${render_jobs.kind} in ('narration', 'master_mix')`),
    )
    .orderBy(desc(render_jobs.started_at));
  return c.json({ items: jobs.map((job) => serializeAudiobookJob(id, job)) });
});

projectsRoute.get("/:id/audiobook/:jobId/download", async (c) => {
  const user = c.get("user");
  const id = c.req.param("id");
  const jobId = c.req.param("jobId");
  const db = drizzle(c.env.DB);
  const [job] = await db
    .select({
      id: render_jobs.id,
      kind: render_jobs.kind,
      output_r2_key: render_jobs.output_r2_key,
      projectId: projects.id,
    })
    .from(render_jobs)
    .innerJoin(projects, eq(render_jobs.project_id, projects.id))
    .where(
      and(
        eq(render_jobs.id, jobId),
        eq(render_jobs.kind, "master_mix"),
        eq(projects.id, id),
        eq(projects.user_id, user.id),
        isNull(projects.deleted_at),
      ),
    )
    .limit(1);
  if (!job?.output_r2_key) return c.json({ error: "audiobook not found" }, 404);
  const object = await c.env.R2.get(job.output_r2_key);
  if (!object) return c.json({ error: "audiobook not found" }, 404);
  return new Response(object.body, {
    headers: {
      "Content-Type": "application/zip",
      "Content-Disposition": `attachment; filename="${id}-audiobook.zip"`,
    },
  });
});

projectsRoute.get("/:id/launch/brief", async (c) => {
  const user = c.get("user");
  const id = c.req.param("id");
  const db = drizzle(c.env.DB);
  const [p] = await db
    .select({ id: projects.id })
    .from(projects)
    .where(and(eq(projects.id, id), eq(projects.user_id, user.id), isNull(projects.deleted_at)))
    .limit(1);
  if (!p) return c.json({ error: "not found" }, 404);

  const [brief] = await db
    .select()
    .from(gtm_briefs)
    .where(eq(gtm_briefs.project_id, id))
    .orderBy(desc(gtm_briefs.updated_at))
    .limit(1);
  return c.json({ brief: brief ? serializeGtmBrief(id, brief) : null });
});

projectsRoute.post("/:id/launch/brief", async (c) => {
  const user = c.get("user");
  const id = c.req.param("id");
  if (!c.env.GTM_BRIEF_WORKFLOW) {
    return c.json({ error: "launch handoff workflow is not configured" }, 503);
  }

  try {
    await prepareGtmBriefInput(c.env, id, user.id);
  } catch (error) {
    const message = error instanceof Error ? error.message : "launch handoff is not ready";
    const status = message.includes("publisher pack")
      ? 409
      : message.includes("not found")
        ? 404
        : 400;
    return c.json({ error: { message } }, status);
  }

  const instanceId = `gtm-brief-${id}-${Date.now()}`;
  await c.env.GTM_BRIEF_WORKFLOW.create({
    id: instanceId,
    params: { projectId: id, userId: user.id },
  });
  return c.json({ id: instanceId }, 202);
});

projectsRoute.get("/:id/launch/brief/download", async (c) => {
  const user = c.get("user");
  const id = c.req.param("id");
  const db = drizzle(c.env.DB);
  const [brief] = await db
    .select({
      id: gtm_briefs.id,
      r2_key: gtm_briefs.r2_key,
      projectId: projects.id,
    })
    .from(gtm_briefs)
    .innerJoin(projects, eq(gtm_briefs.project_id, projects.id))
    .where(and(eq(projects.id, id), eq(projects.user_id, user.id), isNull(projects.deleted_at)))
    .orderBy(desc(gtm_briefs.updated_at))
    .limit(1);
  if (!brief?.r2_key) return c.json({ error: "launch handoff not found" }, 404);
  const object = await c.env.R2.get(brief.r2_key);
  if (!object) return c.json({ error: "launch handoff not found" }, 404);
  return new Response(object.body, {
    headers: {
      "Content-Type": "application/zip",
      "Content-Disposition": `attachment; filename="${id}-launch-handoff.zip"`,
    },
  });
});

projectsRoute.post("/:id/outlines", async (c) => {
  const user = c.get("user");
  const id = c.req.param("id");
  const body = outlineSchema.parse(await c.req.json());
  const db = drizzle(c.env.DB);
  const [p] = await db
    .select()
    .from(projects)
    .where(and(eq(projects.id, id), eq(projects.user_id, user.id), isNull(projects.deleted_at)))
    .limit(1);
  if (!p) return c.json({ error: "not found" }, 404);

  const [voice] = p.voice_id
    ? await db.select().from(voices).where(eq(voices.id, p.voice_id)).limit(1)
    : [];
  const outline = await generateOutlineWithAi(c.env, {
    title: p.title,
    type: p.type,
    genre: p.genre,
    targetWordCount: p.target_word_count,
    framework: body.framework,
    questionnaire: body.questionnaire,
    voiceProfile: voice?.profile_json,
    characterArcs: p.type === "fiction" ? body.character_arcs : undefined,
    scenePlan: p.type === "fiction" ? body.scene_plan : undefined,
    chapterPlan: body.chapter_plan,
  });
  const [{ versionMax }] = await db
    .select({ versionMax: sql<number>`coalesce(max(${outlines.version}), 0)` })
    .from(outlines)
    .where(eq(outlines.project_id, id));
  const version = (versionMax ?? 0) + 1;
  const outlineId = crypto.randomUUID();

  await db.insert(outlines).values({
    id: outlineId,
    project_id: id,
    framework: outline.framework,
    structure_json: outline,
    version,
  });
  await db
    .update(projects)
    .set({ status: "outline", updated_at: new Date() })
    .where(eq(projects.id, id));
  await replaceProjectChapterSkeletons(db, id);

  let ordinal = 1;
  for (const act of outline.acts) {
    for (const chapter of act.chapters) {
      const chapterId = crypto.randomUUID();
      await db.insert(chapters).values({
        id: chapterId,
        project_id: id,
        ordinal,
        title: chapter.title,
        summary: chapter.summary,
        target_words: chapter.target_words,
      });
      for (const [index, section] of chapter.sections.entries()) {
        await db.insert(sections).values({
          id: crypto.randomUUID(),
          chapter_id: chapterId,
          ordinal: index + 1,
          kind: section.kind,
          prompt: section.prompt,
        });
      }
      ordinal += 1;
    }
  }

  return c.json({ id: outlineId, outline, chapters_created: ordinal - 1 }, 201);
});

async function replaceProjectChapterSkeletons(db: ReturnType<typeof drizzle>, projectId: string) {
  const existingChapters = await db
    .select({ id: chapters.id })
    .from(chapters)
    .where(eq(chapters.project_id, projectId));
  const chapterIds = existingChapters.map((chapter) => chapter.id);
  if (!chapterIds.length) return;
  await db.delete(sections).where(inArray(sections.chapter_id, chapterIds));
  await db.delete(chapters).where(eq(chapters.project_id, projectId));
}

projectsRoute.delete("/:id", async (c) => {
  const user = c.get("user");
  const id = c.req.param("id");
  const db = drizzle(c.env.DB);
  await db
    .update(projects)
    .set({ deleted_at: new Date() })
    .where(and(eq(projects.id, id), eq(projects.user_id, user.id)));
  return new Response(null, { status: 204 });
});

function serializePublisherPack(row: typeof publisher_packs.$inferSelect): PublisherSeoPack & {
  id: string;
  status: "draft" | "approved";
} {
  return {
    id: row.id,
    title: row.title,
    subtitle: row.subtitle,
    series_name: row.series_name,
    description_html: row.description_html,
    keywords: Array.isArray(row.keywords_json) ? row.keywords_json.map(String) : [],
    bisac: Array.isArray(row.bisac_json) ? row.bisac_json.map(String) : [],
    status: row.status,
  };
}

function serializeRenderJob(id: string, row: typeof render_jobs.$inferSelect) {
  return {
    ...row,
    download_url:
      row.status === "completed" && row.output_r2_key
        ? `/api/v1/projects/${id}/export/${row.id}/download`
        : null,
  };
}

function serializeAudition(id: string, row: typeof render_jobs.$inferSelect) {
  return {
    ...serializeRenderJob(id, row),
    voice_id: voiceIdFromWorkflow(row.workflow_id),
    audio_url:
      row.status === "completed" && row.output_r2_key
        ? `/api/v1/projects/${id}/narration/auditions/${row.id}/audio`
        : null,
  };
}

function serializeAudiobookJob(id: string, row: typeof render_jobs.$inferSelect) {
  return {
    ...serializeRenderJob(id, row),
    download_url:
      row.kind === "master_mix" && row.status === "completed" && row.output_r2_key
        ? `/api/v1/projects/${id}/audiobook/${row.id}/download`
        : null,
  };
}

function serializeGtmBrief(id: string, row: typeof gtm_briefs.$inferSelect) {
  return {
    ...row,
    download_url: row.r2_key ? `/api/v1/projects/${id}/launch/brief/download` : null,
  };
}

function voiceIdFromWorkflow(workflowId?: string | null) {
  return workflowId?.startsWith("audition:") ? workflowId.slice("audition:".length) : "";
}

function recentDeleteCutoff() {
  return new Date(Date.now() - 30 * 24 * 60 * 60 * 1000);
}

async function renderElevenLabsAudition(apiKey: string, voiceId: string, text: string) {
  const res = await fetch(
    `https://api.elevenlabs.io/v1/text-to-speech/${encodeURIComponent(
      voiceId,
    )}?output_format=mp3_44100_128`,
    {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "xi-api-key": apiKey,
      },
      body: JSON.stringify({
        text,
        model_id: "eleven_multilingual_v2",
        voice_settings: { stability: 0.5, similarity_boost: 0.75 },
      }),
    },
  );
  if (!res.ok) {
    const message = await res.text().catch(() => res.statusText);
    throw new Error(`ElevenLabs ${res.status}: ${message.slice(0, 240)}`);
  }
  return await res.arrayBuffer();
}

function contentTypeForJob(kind: string) {
  if (kind === "epub") return "application/epub+zip";
  if (kind === "pdf") return "application/pdf";
  if (kind === "kpf") return "application/vnd.amazon.mobi8-ebook";
  return "application/octet-stream";
}
