import { and, asc, desc, eq, gte, isNull } from "drizzle-orm";
import { drizzle } from "drizzle-orm/d1";
import { Hono } from "hono";
import { z } from "zod";
import { blog_posts, blogs, users } from "../db/schema";
import type { Env } from "../env";
import { publishEmdashPost } from "../lib/emdash";
import { decryptSecret } from "../lib/keyring";
import { type AuthVariables, requireUser } from "../middleware/auth";
import { BLOG_FORMAT_IDS, getBlogFormat, planPostsForStructure } from "../shared/blog-formats";
import { extrapolateVoiceProfile } from "../skills/blog/voice";

const voiceUploadSchema = z.object({
  name: z.string().max(200).default(""),
  text: z.string().min(1).max(40_000),
});

const createSchema = z.object({
  title: z.string().min(1).max(200),
  format: z.enum(BLOG_FORMAT_IDS),
  description: z.string().min(8).max(500),
  audience: z.array(z.string().min(1).max(80)).max(12).default([]),
  voice_links: z.array(z.string().url()).max(5).default([]),
  voice_uploads: z.array(voiceUploadSchema).max(5).default([]),
  voice_profile_md: z.string().max(20_000).optional(),
  rules_do: z.array(z.string().min(1).max(300)).max(20).default([]),
  rules_dont: z.array(z.string().min(1).max(300)).max(20).default([]),
});

const patchSchema = z.object({
  title: z.string().min(1).max(200).optional(),
  description: z.string().min(8).max(500).optional(),
  emdash_site: z.string().min(1).max(200).nullable().optional(),
});

const planSchema = z.object({
  structure: z.string().min(1).max(80),
  planned_posts: z.number().int().min(1).max(52),
});

const patchPostSchema = z.object({
  title: z.string().max(200).optional(),
  summary: z.string().max(2_000).optional(),
  // Loose BlockNote document shape: an array of blocks, each with a string
  // type. Rejecting anything else keeps a malformed payload from corrupting
  // the post so the editor can no longer open it.
  draft_json: z
    .array(z.looseObject({ type: z.string() }))
    .max(5_000)
    .optional(),
  draft_md: z.string().max(200_000).optional(),
  status: z.enum(["planned", "drafting", "drafted"]).optional(),
});

export const blogsRoute = new Hono<{
  Bindings: Env;
  Variables: AuthVariables;
}>();

blogsRoute.use("*", requireUser);

const blogSummaryColumns = {
  id: blogs.id,
  title: blogs.title,
  format: blogs.format,
  description: blogs.description,
  structure: blogs.structure,
  planned_posts: blogs.planned_posts,
  status: blogs.status,
  emdash_site: blogs.emdash_site,
  created_at: blogs.created_at,
  updated_at: blogs.updated_at,
  deleted_at: blogs.deleted_at,
};

blogsRoute.get("/", async (c) => {
  const user = c.get("user");
  const db = drizzle(c.env.STUDIO_DB);
  const items = await db
    .select(blogSummaryColumns)
    .from(blogs)
    .where(and(eq(blogs.user_id, user.id), isNull(blogs.deleted_at)))
    .orderBy(desc(blogs.updated_at));
  return c.json({ items });
});

blogsRoute.get("/deleted/recent", async (c) => {
  const user = c.get("user");
  const db = drizzle(c.env.STUDIO_DB);
  const items = await db
    .select(blogSummaryColumns)
    .from(blogs)
    .where(and(eq(blogs.user_id, user.id), gte(blogs.deleted_at, recentDeleteCutoff())))
    .orderBy(desc(blogs.deleted_at));
  return c.json({ items, retention_days: 30 });
});

blogsRoute.post("/", async (c) => {
  const user = c.get("user");
  const body = createSchema.parse(await c.req.json());
  if (body.voice_links.length + body.voice_uploads.length < 1) {
    return c.json(
      { error: "at least one example article (link or upload) is required for voice & tone" },
      400,
    );
  }

  let profile = body.voice_profile_md?.trim() ?? "";
  if (!profile) {
    // Best effort: the wizard usually extrapolates ahead of time via
    // /compose/blog-voice; if it didn't, try here but never block creation.
    try {
      const result = await extrapolateVoiceProfile(c.env, {
        links: body.voice_links,
        uploads: body.voice_uploads,
      });
      profile = result.profile_md;
    } catch (err) {
      console.error("blog voice extrapolation failed", (err as Error).message);
    }
  }

  const id = crypto.randomUUID();
  const db = drizzle(c.env.STUDIO_DB);
  await db.insert(blogs).values({
    id,
    user_id: user.id,
    title: body.title,
    format: body.format,
    description: body.description,
    audience_json: body.audience,
    voice_links_json: body.voice_links,
    voice_uploads_json: body.voice_uploads,
    voice_profile_md: profile,
    rules_do_json: body.rules_do,
    rules_dont_json: body.rules_dont,
  });
  return c.json({ id }, 201);
});

blogsRoute.get("/:id", async (c) => {
  const user = c.get("user");
  const id = c.req.param("id");
  const db = drizzle(c.env.STUDIO_DB);
  const [b] = await db
    .select()
    .from(blogs)
    .where(and(eq(blogs.id, id), eq(blogs.user_id, user.id), isNull(blogs.deleted_at)))
    .limit(1);
  if (!b) return c.json({ error: "not found" }, 404);
  return c.json(b);
});

blogsRoute.patch("/:id", async (c) => {
  const user = c.get("user");
  const id = c.req.param("id");
  const body = patchSchema.parse(await c.req.json());
  const db = drizzle(c.env.STUDIO_DB);
  const [b] = await db
    .select({ id: blogs.id })
    .from(blogs)
    .where(and(eq(blogs.id, id), eq(blogs.user_id, user.id), isNull(blogs.deleted_at)))
    .limit(1);
  if (!b) return c.json({ error: "not found" }, 404);

  await db
    .update(blogs)
    .set({ ...body, updated_at: new Date() })
    .where(and(eq(blogs.id, id), eq(blogs.user_id, user.id)));
  return c.json({ ok: true });
});

// Locks in the series structure and planning threshold for the chosen
// format, then creates planned post slots up to the threshold.
blogsRoute.post("/:id/plan", async (c) => {
  const user = c.get("user");
  const id = c.req.param("id");
  const body = planSchema.parse(await c.req.json());
  const db = drizzle(c.env.STUDIO_DB);
  const [b] = await db
    .select()
    .from(blogs)
    .where(and(eq(blogs.id, id), eq(blogs.user_id, user.id), isNull(blogs.deleted_at)))
    .limit(1);
  if (!b) return c.json({ error: "not found" }, 404);

  const format = getBlogFormat(b.format);
  if (!format) return c.json({ error: "unknown blog format" }, 400);
  if (!format.structures.some((s) => s.id === body.structure)) {
    return c.json({ error: `structure not available for ${format.shorthand}` }, 400);
  }
  if (body.planned_posts < format.minPosts) {
    return c.json(
      {
        error: `${format.shorthand} plans at least ${format.minPosts} post${
          format.minPosts === 1 ? "" : "s"
        } at a time`,
      },
      400,
    );
  }

  const existing = await db
    .select({ id: blog_posts.id })
    .from(blog_posts)
    .where(eq(blog_posts.blog_id, id));
  if (body.planned_posts < existing.length) {
    return c.json(
      { error: `cannot plan fewer than the ${existing.length} posts already created` },
      400,
    );
  }
  // Structures with narrative beats (the fiction frameworks) pre-title the
  // planned posts; existing posts are never overwritten.
  const structureDef = format.structures.find((s) => s.id === body.structure);
  const beatPlan = planPostsForStructure(structureDef, body.planned_posts);
  const created: (typeof blog_posts.$inferInsert)[] = [];
  for (let ordinal = existing.length + 1; ordinal <= body.planned_posts; ordinal++) {
    const beat = beatPlan[ordinal - 1];
    created.push({
      id: crypto.randomUUID(),
      blog_id: id,
      ordinal,
      title: beat?.title ?? "",
      summary: beat?.summary ?? "",
    });
  }
  if (created.length > 0) await db.insert(blog_posts).values(created);

  await db
    .update(blogs)
    .set({
      structure: body.structure,
      planned_posts: body.planned_posts,
      status: "planning",
      updated_at: new Date(),
    })
    .where(and(eq(blogs.id, id), eq(blogs.user_id, user.id)));
  return c.json({ ok: true, posts_created: created.length });
});

blogsRoute.get("/:id/posts", async (c) => {
  const user = c.get("user");
  const id = c.req.param("id");
  const db = drizzle(c.env.STUDIO_DB);
  const [b] = await db
    .select({ id: blogs.id })
    .from(blogs)
    .where(and(eq(blogs.id, id), eq(blogs.user_id, user.id), isNull(blogs.deleted_at)))
    .limit(1);
  if (!b) return c.json({ error: "not found" }, 404);
  const items = await db
    .select()
    .from(blog_posts)
    .where(eq(blog_posts.blog_id, id))
    .orderBy(asc(blog_posts.ordinal));
  return c.json({ items });
});

blogsRoute.get("/:id/posts/:postId", async (c) => {
  const user = c.get("user");
  const id = c.req.param("id");
  const postId = c.req.param("postId");
  const db = drizzle(c.env.STUDIO_DB);
  const [b] = await db
    .select({ id: blogs.id })
    .from(blogs)
    .where(and(eq(blogs.id, id), eq(blogs.user_id, user.id), isNull(blogs.deleted_at)))
    .limit(1);
  if (!b) return c.json({ error: "not found" }, 404);
  const [post] = await db
    .select()
    .from(blog_posts)
    .where(and(eq(blog_posts.id, postId), eq(blog_posts.blog_id, id)))
    .limit(1);
  if (!post) return c.json({ error: "post not found" }, 404);
  return c.json(post);
});

blogsRoute.patch("/:id/posts/:postId", async (c) => {
  const user = c.get("user");
  const id = c.req.param("id");
  const postId = c.req.param("postId");
  const body = patchPostSchema.parse(await c.req.json());
  const db = drizzle(c.env.STUDIO_DB);
  const [b] = await db
    .select({ id: blogs.id })
    .from(blogs)
    .where(and(eq(blogs.id, id), eq(blogs.user_id, user.id), isNull(blogs.deleted_at)))
    .limit(1);
  if (!b) return c.json({ error: "not found" }, 404);
  const [post] = await db
    .select({ id: blog_posts.id, status: blog_posts.status })
    .from(blog_posts)
    .where(and(eq(blog_posts.id, postId), eq(blog_posts.blog_id, id)))
    .limit(1);
  if (!post) return c.json({ error: "post not found" }, 404);

  // First draft content promotes a planned post to drafting. Done here (not
  // in the client autosave) so a delayed save can never downgrade a status
  // the user set explicitly in the meantime.
  const values: typeof body & { updated_at: Date } = { ...body, updated_at: new Date() };
  if (
    values.status === undefined &&
    post.status === "planned" &&
    body.draft_md !== undefined &&
    body.draft_md.trim().length > 0
  ) {
    values.status = "drafting";
  }

  await db.update(blog_posts).set(values).where(eq(blog_posts.id, postId));
  return c.json({ ok: true });
});

// Publishes a drafted post straight to the blog's connected em_dash site via
// pub.fly.pm. The only setup the user does in Book Cook is authenticating
// with pub.fly.pm (account-level token) and picking the site.
blogsRoute.post("/:id/posts/:postId/publish", async (c) => {
  const user = c.get("user");
  const id = c.req.param("id");
  const postId = c.req.param("postId");
  const db = drizzle(c.env.STUDIO_DB);
  const [b] = await db
    .select()
    .from(blogs)
    .where(and(eq(blogs.id, id), eq(blogs.user_id, user.id), isNull(blogs.deleted_at)))
    .limit(1);
  if (!b) return c.json({ error: "not found" }, 404);
  if (!b.emdash_site) {
    return c.json({ error: "connect an em_dash site before publishing" }, 400);
  }

  const [row] = await db
    .select({
      ciphertext: users.emdash_token_ciphertext,
      iv: users.emdash_token_iv,
    })
    .from(users)
    .where(eq(users.id, user.id))
    .limit(1);
  if (!row?.ciphertext || !row.iv) {
    return c.json({ error: "authenticate with pub.fly.pm first" }, 400);
  }

  const [post] = await db
    .select()
    .from(blog_posts)
    .where(and(eq(blog_posts.id, postId), eq(blog_posts.blog_id, id)))
    .limit(1);
  if (!post) return c.json({ error: "post not found" }, 404);
  if (!post.draft_md.trim()) {
    return c.json({ error: "post has no draft to publish yet" }, 400);
  }

  const token = await decryptSecret(
    row.ciphertext as ArrayBuffer,
    row.iv as ArrayBuffer,
    c.env.KEYRING_MASTER_KEY,
  );
  const result = await publishEmdashPost(c.env, token, b.emdash_site, {
    title: post.title || `${b.title} — Post ${post.ordinal}`,
    body_md: post.draft_md,
    summary: post.summary,
  });

  await db
    .update(blog_posts)
    .set({
      status: "published",
      emdash_post_id: result.id || null,
      published_at: new Date(),
      updated_at: new Date(),
    })
    .where(eq(blog_posts.id, postId));
  await db
    .update(blogs)
    .set({ status: "publishing", updated_at: new Date() })
    .where(eq(blogs.id, id));
  return c.json({ ok: true, emdash_post_id: result.id, url: result.url ?? null });
});

blogsRoute.delete("/:id", async (c) => {
  const user = c.get("user");
  const id = c.req.param("id");
  const db = drizzle(c.env.STUDIO_DB);
  await db
    .update(blogs)
    .set({ deleted_at: new Date() })
    .where(and(eq(blogs.id, id), eq(blogs.user_id, user.id)));
  return new Response(null, { status: 204 });
});

blogsRoute.post("/:id/restore", async (c) => {
  const user = c.get("user");
  const id = c.req.param("id");
  const db = drizzle(c.env.STUDIO_DB);
  const [b] = await db
    .select({ id: blogs.id })
    .from(blogs)
    .where(
      and(
        eq(blogs.id, id),
        eq(blogs.user_id, user.id),
        gte(blogs.deleted_at, recentDeleteCutoff()),
      ),
    )
    .limit(1);
  if (!b) return c.json({ error: "deleted blog not found" }, 404);

  await db
    .update(blogs)
    .set({ deleted_at: null, updated_at: new Date() })
    .where(and(eq(blogs.id, id), eq(blogs.user_id, user.id)));
  return c.json({ ok: true });
});

function recentDeleteCutoff() {
  return new Date(Date.now() - 30 * 24 * 60 * 60 * 1000);
}
