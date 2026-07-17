import { and, asc, eq, isNull, lt, ne, or, sql } from "drizzle-orm";
import { drizzle } from "drizzle-orm/d1";
import { Hono } from "hono";
import { z } from "zod";
import { chapters, projects, revisions, sections, voices } from "../db/schema";
import type { Env } from "../env";
import {
  aiRequestFingerprint,
  aiReservationCostCents,
  aiUsageCostCents,
  budgetCapCents,
  completeAiBudgetRequest,
  failAiBudgetRequest,
  parseIdempotencyKey,
  reserveAiBudgetRequest,
  stageAiBudgetRequest,
} from "../lib/budget";
import { type AuthVariables, requireUser } from "../middleware/auth";
import { draftSection, reviseInlineText } from "../skills/writer";

const patchChapterSchema = z.object({
  title: z.string().min(1).max(200).optional(),
  summary: z.string().max(2_000).optional(),
  // Loose BlockNote document shape: an array of blocks, each with a string
  // type. Rejecting anything else keeps a malformed payload from corrupting
  // the chapter so the editor can no longer open it.
  draft_json: z
    .array(z.looseObject({ type: z.string() }))
    .max(5_000)
    .optional(),
  draft_md: z.string().max(2_000_000).optional(),
  draft_version: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER).optional(),
  draft_session_id: z.string().uuid().optional(),
  draft_sequence: z.number().int().positive().max(Number.MAX_SAFE_INTEGER).optional(),
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

type InlineRevisionResponse = {
  revision: {
    id: string;
    target_table: string;
    target_id: string;
    before_md: string;
    after_md: string;
    llm_response: Awaited<ReturnType<typeof reviseInlineText>>["llm_response"];
  };
};

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

  const inlineInput = {
    action: body.action,
    tone: body.tone,
    text: body.text,
    contextMd: body.context_md,
    chapterTitle: row.chapter.title,
    chapterSummary: row.chapter.summary,
    voiceProfile: row.voice?.profile_json,
  };
  const hosted = Boolean(c.env.AI_GATEWAY_BASE_URL && c.env.AI_GATEWAY_TOKEN);
  const requestId = hosted ? parseIdempotencyKey(c.req.header("Idempotency-Key")) : null;
  if (hosted && !requestId) {
    return c.json({ error: "a valid Idempotency-Key UUID is required" }, 400);
  }

  const fingerprint = hosted
    ? await aiRequestFingerprint(["chapter-inline-revise", id, body])
    : null;
  const reservationResult =
    hosted && requestId && fingerprint
      ? await reserveAiBudgetRequest(c.env.DB, {
          requestId,
          userId: user.id,
          fingerprint,
          route: "dynamic/text_gen",
          reservedCents: aiReservationCostCents(
            "dynamic/text_gen",
            JSON.stringify(["You revise selected prose inside a book editor.", inlineInput]),
            900,
          ),
          capCents: budgetCapCents(user.plan),
        })
      : null;
  if (reservationResult?.state === "conflict") {
    return c.json({ error: "Idempotency-Key was already used for another request" }, 409);
  }
  if (reservationResult?.state === "pending") {
    c.header("Retry-After", "1");
    return c.json({ error: "request is still in progress", retryable: true }, 409);
  }
  if (reservationResult?.state === "replay") {
    return c.json(reservationResult.response as InlineRevisionResponse);
  }
  if (reservationResult?.state === "staged") {
    const response = reservationResult.response as InlineRevisionResponse;
    if (response.revision.id !== reservationResult.revisionId) {
      throw new Error("staged chapter revision does not match its reservation");
    }
    await completeAiBudgetRequest(c.env.DB, reservationResult.reservation, {
      id: response.revision.id,
      targetTable: "chapters",
      targetId: id,
      beforeMarkdown: response.revision.before_md,
      afterMarkdown: response.revision.after_md,
      llmResponse: response.revision.llm_response,
    });
    return c.json(response);
  }

  let result: Awaited<ReturnType<typeof reviseInlineText>>;
  try {
    result = await reviseInlineText(c.env, inlineInput);
  } catch (error) {
    if (reservationResult?.state === "acquired") {
      await failAiBudgetRequest(c.env.DB, reservationResult.reservation).catch(() => undefined);
    }
    throw error;
  }
  const revisionId = crypto.randomUUID();
  const response = {
    revision: {
      id: revisionId,
      target_table: "chapters",
      target_id: id,
      before_md: body.text,
      after_md: result.markdown,
      llm_response: result.llm_response,
    },
  };

  if (reservationResult?.state === "acquired") {
    await stageAiBudgetRequest(c.env.DB, reservationResult.reservation, {
      actualCents: aiUsageCostCents(result.llm_response),
      response,
      revisionId,
    });
    await completeAiBudgetRequest(c.env.DB, reservationResult.reservation, {
      id: revisionId,
      targetTable: "chapters",
      targetId: id,
      beforeMarkdown: body.text,
      afterMarkdown: result.markdown,
      llmResponse: result.llm_response,
    });
  } else {
    await db.insert(revisions).values({
      id: revisionId,
      target_table: "chapters",
      target_id: id,
      before_md: body.text,
      after_md: result.markdown,
      llm_response: result.llm_response,
    });
  }

  return c.json(response);
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

  const [chapter] = await db
    .select({ chapterId: chapters.id })
    .from(chapters)
    .innerJoin(projects, eq(chapters.project_id, projects.id))
    .where(and(eq(chapters.id, id), eq(projects.user_id, user.id), isNull(projects.deleted_at)))
    .limit(1);
  if (!chapter) return c.json({ error: "not found" }, 404);

  const rows = await db
    .select({ revision: revisions })
    .from(revisions)
    .leftJoin(
      sections,
      and(eq(revisions.target_table, "sections"), eq(revisions.target_id, sections.id)),
    )
    .where(
      or(
        and(eq(revisions.target_table, "chapters"), eq(revisions.target_id, id)),
        and(eq(revisions.target_table, "sections"), eq(sections.chapter_id, id)),
      ),
    )
    .orderBy(asc(revisions.created_at), asc(revisions.id));
  return c.json({ items: rows.map((row) => row.revision) });
});

chaptersRoute.patch("/:id", async (c) => {
  const user = c.get("user");
  const id = c.req.param("id");
  const parsed = patchChapterSchema.safeParse(await c.req.json());
  if (!parsed.success) return c.json({ error: "invalid chapter update" }, 400);
  const body = parsed.data;
  const db = drizzle(c.env.DB);
  const [row] = await db
    .select({ chapterId: chapters.id })
    .from(chapters)
    .innerJoin(projects, eq(chapters.project_id, projects.id))
    .where(and(eq(chapters.id, id), eq(projects.user_id, user.id), isNull(projects.deleted_at)))
    .limit(1);
  if (!row) return c.json({ error: "not found" }, 404);

  const hasDraftUpdate = body.draft_json !== undefined || body.draft_md !== undefined;
  if (
    hasDraftUpdate &&
    (body.draft_version === undefined ||
      body.draft_session_id === undefined ||
      body.draft_sequence === undefined)
  ) {
    return c.json({ error: "draft concurrency fields are required for draft updates" }, 400);
  }

  const {
    draft_version: expectedDraftVersion,
    draft_session_id: draftSessionId,
    draft_sequence: draftSequence,
    ...patch
  } = body;
  if (!hasDraftUpdate) {
    const [updated] = await db
      .update(chapters)
      .set({ ...patch, updated_at: new Date() })
      .where(eq(chapters.id, id))
      .returning({ draft_version: chapters.draft_version });
    if (!updated) return c.json({ error: "not found" }, 404);
    return c.json({ ok: true, draft_version: updated.draft_version });
  }

  const [updated] = await db
    .update(chapters)
    .set({
      ...patch,
      draft_version: sql`${chapters.draft_version} + 1`,
      draft_session_id: draftSessionId,
      draft_sequence: draftSequence,
      updated_at: new Date(),
    })
    .where(
      and(
        eq(chapters.id, id),
        or(
          and(
            eq(chapters.draft_session_id, draftSessionId as string),
            lt(chapters.draft_sequence, draftSequence as number),
          ),
          and(
            or(
              isNull(chapters.draft_session_id),
              ne(chapters.draft_session_id, draftSessionId as string),
            ),
            eq(chapters.draft_version, expectedDraftVersion as number),
          ),
        ),
      ),
    )
    .returning({ draft_version: chapters.draft_version });
  if (!updated) {
    const [current] = await db
      .select({ draft_version: chapters.draft_version })
      .from(chapters)
      .where(eq(chapters.id, id))
      .limit(1);
    return c.json({ error: "stale draft", draft_version: current?.draft_version ?? 0 }, 409);
  }
  return c.json({ ok: true, draft_version: updated.draft_version });
});
