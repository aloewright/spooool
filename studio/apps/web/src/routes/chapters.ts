import { and, asc, eq, isNull } from "drizzle-orm";
import { drizzle } from "drizzle-orm/d1";
import { Hono } from "hono";
import { z } from "zod";
import { chapters, projects, revisions, sections, voices } from "../db/schema";
import type { Env } from "../env";
import { type AuthVariables, requireUser } from "../middleware/auth";
import { draftSection, reviseInlineText } from "../skills/writer";

const patchChapterSchema = z.object({
  title: z.string().min(1).max(200).optional(),
  summary: z.string().max(2_000).optional(),
  draft_json: z.unknown().optional(),
  draft_md: z.string().max(2_000_000).optional(),
  status: z.enum(["pending", "drafting", "drafted", "approved"]).optional(),
});

const patchSectionSchema = z.object({
  status: z.enum(["pending", "generating", "drafted", "approved"]).optional(),
  draft_md: z.string().max(500_000).optional(),
  prompt: z.string().max(10_000).optional(),
  beginning_md: z.string().max(500_000).optional(),
  middle_md: z.string().max(500_000).optional(),
  end_md: z.string().max(500_000).optional(),
});

const createSectionSchema = z.object({
  kind: z.string().default("scene"),
  prompt: z.string().max(10_000).default(""),
});

const reorderSectionsSchema = z.object({
  ordinals: z.array(z.object({ id: z.string(), ordinal: z.number().int().min(0) })),
});

const moveSectionSchema = z.object({
  target_chapter_id: z.string(),
});

const draftSectionSchema = z.object({
  instruction: z.string().max(4000).optional(),
});

const reviseInlineSchema = z.object({
  action: z.enum(["rewrite", "tighten", "expand", "change-tone", "fix-grammar"]),
  tone: z.enum(["formal", "casual", "punchy"]).optional(),
  text: z.string().min(1).max(20_000),
  context_md: z.string().max(100_000).optional(),
});

export const chaptersRoute = new Hono<{
  Bindings: Env;
  Variables: AuthVariables;
}>();

chaptersRoute.use("*", requireUser);

chaptersRoute.get("/:id", async (c) => {
  const user = c.get("user");
  const id = c.req.param("id");
  const db = drizzle(c.env.DB);
  const [row] = await db
    .select({ chapter: chapters, project: projects })
    .from(chapters)
    .innerJoin(projects, eq(chapters.project_id, projects.id))
    .where(and(eq(chapters.id, id), eq(projects.user_id, user.id), isNull(projects.deleted_at)))
    .limit(1);
  if (!row) return c.json({ error: "not found" }, 404);
  return c.json(row.chapter);
});

chaptersRoute.get("/:id/sections", async (c) => {
  const user = c.get("user");
  const id = c.req.param("id");
  const db = drizzle(c.env.DB);
  const [row] = await db
    .select({ chapterId: chapters.id })
    .from(chapters)
    .innerJoin(projects, eq(chapters.project_id, projects.id))
    .where(and(eq(chapters.id, id), eq(projects.user_id, user.id), isNull(projects.deleted_at)))
    .limit(1);
  if (!row) return c.json({ error: "not found" }, 404);

  const items = await db
    .select()
    .from(sections)
    .where(eq(sections.chapter_id, id))
    .orderBy(asc(sections.ordinal));

  return c.json({ items });
});

chaptersRoute.post("/:id/sections", async (c) => {
  const user = c.get("user");
  const id = c.req.param("id");
  const body = createSectionSchema.parse(await c.req.json().catch(() => ({})));
  const db = drizzle(c.env.DB);
  const [row] = await db
    .select({ chapterId: chapters.id })
    .from(chapters)
    .innerJoin(projects, eq(chapters.project_id, projects.id))
    .where(and(eq(chapters.id, id), eq(projects.user_id, user.id), isNull(projects.deleted_at)))
    .limit(1);
  if (!row) return c.json({ error: "not found" }, 404);

  const existing = await db
    .select({ ordinal: sections.ordinal })
    .from(sections)
    .where(eq(sections.chapter_id, id))
    .orderBy(asc(sections.ordinal));
  const nextOrdinal = existing.length > 0 ? (existing[existing.length - 1]?.ordinal ?? 0) + 1 : 1;

  const sectionId = crypto.randomUUID();
  await db.insert(sections).values({
    id: sectionId,
    chapter_id: id,
    ordinal: nextOrdinal,
    kind: body.kind,
    prompt: body.prompt,
    created_at: new Date(),
    updated_at: new Date(),
  });
  const [section] = await db.select().from(sections).where(eq(sections.id, sectionId)).limit(1);
  return c.json({ section }, 201);
});

chaptersRoute.post("/:id/sections/reorder", async (c) => {
  const user = c.get("user");
  const id = c.req.param("id");
  const body = reorderSectionsSchema.parse(await c.req.json());
  const db = drizzle(c.env.DB);
  const [row] = await db
    .select({ chapterId: chapters.id })
    .from(chapters)
    .innerJoin(projects, eq(chapters.project_id, projects.id))
    .where(and(eq(chapters.id, id), eq(projects.user_id, user.id), isNull(projects.deleted_at)))
    .limit(1);
  if (!row) return c.json({ error: "not found" }, 404);

  const now = new Date();
  for (const { id: sectionId, ordinal } of body.ordinals) {
    await db
      .update(sections)
      .set({ ordinal, updated_at: now })
      .where(and(eq(sections.id, sectionId), eq(sections.chapter_id, id)));
  }
  return c.json({ ok: true });
});

chaptersRoute.post("/:id/revise", async (c) => {
  const user = c.get("user");
  const id = c.req.param("id");
  const body = reviseInlineSchema.parse(await c.req.json());
  const db = drizzle(c.env.DB);
  const [row] = await db
    .select({ chapter: chapters, project: projects, voice: voices })
    .from(chapters)
    .innerJoin(projects, eq(chapters.project_id, projects.id))
    .leftJoin(voices, eq(projects.voice_id, voices.id))
    .where(and(eq(chapters.id, id), eq(projects.user_id, user.id), isNull(projects.deleted_at)))
    .limit(1);
  if (!row) return c.json({ error: "not found" }, 404);

  const result = await reviseInlineText(c.env, {
    action: body.action,
    tone: body.tone,
    text: body.text,
    contextMd: body.context_md,
    chapterTitle: row.chapter.title,
    chapterSummary: row.chapter.summary,
    voiceProfile: row.voice?.profile_json,
  });
  const revisionId = crypto.randomUUID();
  await db.insert(revisions).values({
    id: revisionId,
    target_table: "chapters",
    target_id: id,
    before_md: body.text,
    after_md: result.markdown,
    llm_response: result.llm_response,
  });

  return c.json({
    revision: {
      id: revisionId,
      target_table: "chapters",
      target_id: id,
      before_md: body.text,
      after_md: result.markdown,
      llm_response: result.llm_response,
    },
  });
});

chaptersRoute.post("/:id/sections/:sectionId/draft", async (c) => {
  const user = c.get("user");
  const chapterId = c.req.param("id");
  const sectionId = c.req.param("sectionId");
  const body = draftSectionSchema.parse(await c.req.json().catch(() => ({})));
  const db = drizzle(c.env.DB);
  const [row] = await db
    .select({ chapter: chapters, project: projects, section: sections, voice: voices })
    .from(sections)
    .innerJoin(chapters, eq(sections.chapter_id, chapters.id))
    .innerJoin(projects, eq(chapters.project_id, projects.id))
    .leftJoin(voices, eq(projects.voice_id, voices.id))
    .where(
      and(
        eq(chapters.id, chapterId),
        eq(sections.id, sectionId),
        eq(projects.user_id, user.id),
        isNull(projects.deleted_at),
      ),
    )
    .limit(1);
  if (!row) return c.json({ error: "not found" }, 404);

  await db
    .update(sections)
    .set({ status: "generating", updated_at: new Date() })
    .where(eq(sections.id, sectionId));

  const result = await draftSection(c.env, {
    projectTitle: row.project.title,
    projectType: row.project.type,
    chapterTitle: row.chapter.title,
    chapterSummary: row.chapter.summary,
    kind: row.section.kind,
    prompt: row.section.prompt,
    previousDraft: row.section.draft_md,
    currentChapterDraft: row.chapter.draft_md,
    redraftInstruction: body.instruction?.trim(),
    voiceProfile: row.voice?.profile_json,
  });
  const revisionId = crypto.randomUUID();
  const now = new Date();

  await db.insert(revisions).values({
    id: revisionId,
    target_table: "sections",
    target_id: sectionId,
    before_md: row.section.draft_md,
    after_md: result.markdown,
    llm_response: result.llm_response,
  });
  await db
    .update(sections)
    .set({ draft_md: result.markdown, status: "drafted", updated_at: now })
    .where(eq(sections.id, sectionId));
  await db
    .update(chapters)
    .set({ status: "drafting", updated_at: now })
    .where(eq(chapters.id, chapterId));

  const [section] = await db.select().from(sections).where(eq(sections.id, sectionId)).limit(1);
  return c.json({
    section,
    revision: { id: revisionId, before_md: row.section.draft_md, after_md: result.markdown },
  });
});

chaptersRoute.patch("/:id/sections/:sectionId", async (c) => {
  const user = c.get("user");
  const chapterId = c.req.param("id");
  const sectionId = c.req.param("sectionId");
  const body = patchSectionSchema.parse(await c.req.json());
  const db = drizzle(c.env.DB);
  const [row] = await db
    .select({ sectionId: sections.id })
    .from(sections)
    .innerJoin(chapters, eq(sections.chapter_id, chapters.id))
    .innerJoin(projects, eq(chapters.project_id, projects.id))
    .where(
      and(
        eq(chapters.id, chapterId),
        eq(sections.id, sectionId),
        eq(projects.user_id, user.id),
        isNull(projects.deleted_at),
      ),
    )
    .limit(1);
  if (!row) return c.json({ error: "not found" }, 404);

  await db
    .update(sections)
    .set({ ...body, updated_at: new Date() })
    .where(eq(sections.id, sectionId));
  return c.json({ ok: true });
});

chaptersRoute.post("/:id/sections/:sectionId/move", async (c) => {
  const user = c.get("user");
  const fromChapterId = c.req.param("id");
  const sectionId = c.req.param("sectionId");
  const { target_chapter_id } = moveSectionSchema.parse(await c.req.json());
  const db = drizzle(c.env.DB);

  const [srcRow] = await db
    .select({ sectionId: sections.id })
    .from(sections)
    .innerJoin(chapters, eq(sections.chapter_id, chapters.id))
    .innerJoin(projects, eq(chapters.project_id, projects.id))
    .where(
      and(
        eq(chapters.id, fromChapterId),
        eq(sections.id, sectionId),
        eq(projects.user_id, user.id),
        isNull(projects.deleted_at),
      ),
    )
    .limit(1);
  if (!srcRow) return c.json({ error: "not found" }, 404);

  const [dstRow] = await db
    .select({ chapterId: chapters.id })
    .from(chapters)
    .innerJoin(projects, eq(chapters.project_id, projects.id))
    .where(
      and(
        eq(chapters.id, target_chapter_id),
        eq(projects.user_id, user.id),
        isNull(projects.deleted_at),
      ),
    )
    .limit(1);
  if (!dstRow) return c.json({ error: "target chapter not found" }, 404);

  const dstSections = await db
    .select({ ordinal: sections.ordinal })
    .from(sections)
    .where(eq(sections.chapter_id, target_chapter_id))
    .orderBy(asc(sections.ordinal));
  const nextOrdinal =
    dstSections.length > 0 ? (dstSections[dstSections.length - 1]?.ordinal ?? 0) + 1 : 1;

  await db
    .update(sections)
    .set({ chapter_id: target_chapter_id, ordinal: nextOrdinal, updated_at: new Date() })
    .where(eq(sections.id, sectionId));

  const [section] = await db.select().from(sections).where(eq(sections.id, sectionId)).limit(1);
  return c.json({ section });
});

chaptersRoute.get("/:id/revisions", async (c) => {
  const user = c.get("user");
  const id = c.req.param("id");
  const db = drizzle(c.env.DB);
  const rows = await db
    .select({ revision: revisions })
    .from(revisions)
    .innerJoin(sections, eq(revisions.target_id, sections.id))
    .innerJoin(chapters, eq(sections.chapter_id, chapters.id))
    .innerJoin(projects, eq(chapters.project_id, projects.id))
    .where(
      and(
        eq(chapters.id, id),
        eq(revisions.target_table, "sections"),
        eq(projects.user_id, user.id),
        isNull(projects.deleted_at),
      ),
    )
    .orderBy(asc(revisions.created_at));
  return c.json({ items: rows.map((row) => row.revision) });
});

chaptersRoute.patch("/:id", async (c) => {
  const user = c.get("user");
  const id = c.req.param("id");
  const body = patchChapterSchema.parse(await c.req.json());
  const db = drizzle(c.env.DB);
  const [row] = await db
    .select({ chapterId: chapters.id })
    .from(chapters)
    .innerJoin(projects, eq(chapters.project_id, projects.id))
    .where(and(eq(chapters.id, id), eq(projects.user_id, user.id), isNull(projects.deleted_at)))
    .limit(1);
  if (!row) return c.json({ error: "not found" }, 404);

  await db
    .update(chapters)
    .set({
      ...body,
      updated_at: new Date(),
    })
    .where(eq(chapters.id, id));
  return c.json({ ok: true });
});
