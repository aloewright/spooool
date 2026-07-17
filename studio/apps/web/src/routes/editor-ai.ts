import { and, eq, isNull } from "drizzle-orm";
import { type DrizzleD1Database, drizzle } from "drizzle-orm/d1";
import { Hono } from "hono";
import {
  blog_posts,
  blogs,
  chapters,
  projects,
  revisions,
  script_scenes,
  scripts,
  voices,
} from "../db/schema";
import type { Env } from "../env";
import { aiUsageCostCents, recordUsage } from "../lib/budget";
import { type AuthVariables, requireUser } from "../middleware/auth";
import { enforceBudget } from "../middleware/budget";
import {
  type EditorAiRequest,
  type EditorAiRevision,
  editorAiRequestSchema,
} from "../shared/editor-ai";
import type { EditorResourceContext } from "../skills/editor-command";
import { runEditorCommand } from "../skills/editor-command";

type EditorTargetTable = "chapters" | "blog_posts" | "script_scenes";
const EDITOR_AI_REQUEST_BODY_MAX_BYTES = 310_000;

type BoundedRequestBody =
  | { tooLarge: true }
  | {
      tooLarge: false;
      text: string;
    };

type ResolvedEditorResourceContext = {
  context: EditorResourceContext;
  targetTable: EditorTargetTable;
};

export async function resolveEditorResourceContext(
  db: DrizzleD1Database,
  userId: string,
  resourceKind: EditorAiRequest["resource_kind"],
  resourceId: string,
): Promise<ResolvedEditorResourceContext | null> {
  if (resourceKind === "chapter") {
    const [row] = await db
      .select({
        projectTitle: projects.title,
        projectType: projects.type,
        chapterTitle: chapters.title,
        chapterSummary: chapters.summary,
        voiceProfile: voices.profile_json,
      })
      .from(chapters)
      .innerJoin(projects, eq(chapters.project_id, projects.id))
      .leftJoin(voices, eq(projects.voice_id, voices.id))
      .where(
        and(eq(chapters.id, resourceId), eq(projects.user_id, userId), isNull(projects.deleted_at)),
      )
      .limit(1);
    if (!row) return null;
    return {
      targetTable: "chapters",
      context: {
        kind: "chapter",
        projectTitle: row.projectTitle,
        projectType: row.projectType,
        chapterTitle: row.chapterTitle,
        chapterSummary: row.chapterSummary,
        voiceProfile: row.voiceProfile ?? undefined,
      },
    };
  }

  if (resourceKind === "blog-post") {
    const [row] = await db
      .select({
        blogTitle: blogs.title,
        blogDescription: blogs.description,
        blogFormat: blogs.format,
        postTitle: blog_posts.title,
        postSummary: blog_posts.summary,
        voiceProfile: blogs.voice_profile_md,
        doRules: blogs.rules_do_json,
        dontRules: blogs.rules_dont_json,
      })
      .from(blog_posts)
      .innerJoin(blogs, eq(blog_posts.blog_id, blogs.id))
      .where(
        and(eq(blog_posts.id, resourceId), eq(blogs.user_id, userId), isNull(blogs.deleted_at)),
      )
      .limit(1);
    if (!row) return null;
    return {
      targetTable: "blog_posts",
      context: {
        kind: "blog-post",
        blogTitle: row.blogTitle,
        blogDescription: row.blogDescription,
        blogFormat: row.blogFormat,
        postTitle: row.postTitle,
        postSummary: row.postSummary,
        voiceProfile: row.voiceProfile || undefined,
        doRules: stringArray(row.doRules),
        dontRules: stringArray(row.dontRules),
      },
    };
  }

  const [row] = await db
    .select({
      scriptTitle: scripts.title,
      scriptFormat: scripts.format,
      logline: scripts.logline,
      genre: scripts.genre,
      sceneTitle: script_scenes.title,
      sceneSummary: script_scenes.summary,
      sceneOrdinal: script_scenes.ordinal,
    })
    .from(script_scenes)
    .innerJoin(scripts, eq(script_scenes.script_id, scripts.id))
    .where(
      and(
        eq(script_scenes.id, resourceId),
        eq(scripts.user_id, userId),
        isNull(scripts.deleted_at),
      ),
    )
    .limit(1);
  if (!row) return null;
  return {
    targetTable: "script_scenes",
    context: {
      kind: "script-scene",
      scriptTitle: row.scriptTitle,
      scriptFormat: row.scriptFormat,
      logline: row.logline,
      genre: row.genre ?? "",
      sceneTitle: row.sceneTitle,
      sceneSummary: row.sceneSummary,
      sceneOrdinal: row.sceneOrdinal,
    },
  };
}

export const editorAiRoute = new Hono<{
  Bindings: Env;
  Variables: AuthVariables;
}>();

editorAiRoute.use("*", requireUser);

editorAiRoute.post("/ai", enforceBudget("editor-ai"), async (c) => {
  const declaredLength = Number(c.req.header("content-length"));
  if (Number.isFinite(declaredLength) && declaredLength > EDITOR_AI_REQUEST_BODY_MAX_BYTES) {
    return c.json({ error: "request too large" }, 413);
  }

  let body: BoundedRequestBody;
  try {
    body = await readBoundedRequestBody(c.req.raw, EDITOR_AI_REQUEST_BODY_MAX_BYTES);
  } catch {
    return c.json({ error: "invalid request" }, 400);
  }
  if (body.tooLarge) return c.json({ error: "request too large" }, 413);

  let json: unknown;
  try {
    json = JSON.parse(body.text);
  } catch {
    return c.json({ error: "invalid request" }, 400);
  }
  const parsed = editorAiRequestSchema.safeParse(json);
  if (!parsed.success) return c.json({ error: "invalid request" }, 400);
  const request = parsed.data;

  const db = drizzle(c.env.DB);
  const resolved = await resolveEditorResourceContext(
    db,
    c.get("user").id,
    request.resource_kind,
    request.resource_id,
  );
  if (!resolved) return c.json({ error: "not found" }, 404);

  const result = await runEditorCommand(c.env, { request, context: resolved.context });
  const revision: EditorAiRevision = {
    id: crypto.randomUUID(),
    before_md: request.target_md,
    after_md: result.markdown,
    llm_response: result.llm_response,
  };
  await db.insert(revisions).values({
    id: revision.id,
    target_table: resolved.targetTable,
    target_id: request.resource_id,
    before_md: revision.before_md,
    after_md: revision.after_md,
    llm_response: revision.llm_response,
  });
  await recordUsage(c.env.KV, c.get("user").id, aiUsageCostCents(result.llm_response));

  return c.json({ revision });
});

async function readBoundedRequestBody(
  request: Request,
  maxBytes: number,
): Promise<BoundedRequestBody> {
  if (!request.body) return { tooLarge: false, text: "" };

  const reader = request.body.getReader();
  const chunks: Uint8Array[] = [];
  let totalBytes = 0;

  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;

      const chunk = value as Uint8Array;
      totalBytes += chunk.byteLength;
      if (totalBytes > maxBytes) {
        await reader.cancel("request too large").catch(() => undefined);
        return { tooLarge: true };
      }
      chunks.push(chunk);
    }
  } finally {
    reader.releaseLock();
  }

  const bytes = new Uint8Array(totalBytes);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return { tooLarge: false, text: new TextDecoder().decode(bytes) };
}

function stringArray(value: unknown): string[] | undefined {
  if (!Array.isArray(value)) return undefined;
  const strings = value.filter((item): item is string => typeof item === "string");
  return strings.length > 0 ? strings : undefined;
}
