// ALO-151: tag/category browse.
//
// Public surface:
//   GET  /api/tags                         — top tags by video count
//   GET  /api/tags/:slug                   — videos for one tag (paged)
//   GET  /api/videos/:id/tags              — tag chips for a watch page
//   PUT  /api/videos/:id/tags              — owner-only, replaces the tag list
//
// Slugs are the canonical id. Labels are stored once on `tags.label` so we
// don't have to canonicalise on every read. Free-form tag input is
// normalised at the boundary by `normaliseTagInput` so we never persist two
// near-duplicates ("Music", "music ", "MUSIC!") for the same concept.

import { Hono } from 'hono';
import { z } from 'zod';
import { purgeEdgeCache } from './edge-cache';

export interface TagsEnv {
  DB: D1Database;
}

type SessionUser = { id: string; email: string; name: string } | null;
type TagsVariables = { user: SessionUser };

const MAX_TAGS_PER_VIDEO = 8;
const TAG_LABEL_MAX = 32;

const listTopQuerySchema = z.object({
  limit: z.coerce.number().int().positive().max(50).default(20),
});

const tagVideosQuerySchema = z.object({
  page: z.coerce.number().int().positive().default(1),
  limit: z.coerce.number().int().positive().max(50).default(20),
});

const updateTagsBodySchema = z.object({
  tags: z.array(z.string().min(1).max(TAG_LABEL_MAX)).max(MAX_TAGS_PER_VIDEO),
});

export interface NormalisedTag {
  slug: string;
  label: string;
}

// Lowercase, ASCII-fold a couple of common cases, collapse whitespace, strip
// to [a-z0-9-]. We keep it deliberately simple — anything more elaborate
// belongs in a real slugifier dep, which we don't want to pull in.
export function normaliseTagInput(raw: string): NormalisedTag | null {
  const label = raw.trim().slice(0, TAG_LABEL_MAX);
  if (!label) return null;
  const slug = label
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, TAG_LABEL_MAX);
  if (!slug) return null;
  return { slug, label };
}

// Dedupe by slug, preserving the first label encountered. The caller is
// passing user-supplied tags; we cap at MAX_TAGS_PER_VIDEO upstream.
export function dedupeTags(tags: NormalisedTag[]): NormalisedTag[] {
  const seen = new Map<string, NormalisedTag>();
  for (const tag of tags) {
    if (!seen.has(tag.slug)) seen.set(tag.slug, tag);
  }
  return Array.from(seen.values());
}

export const tagRoutes = new Hono<{
  Bindings: TagsEnv;
  Variables: TagsVariables;
}>();

tagRoutes.get('/api/tags', async (c) => {
  const parsed = listTopQuerySchema.safeParse(c.req.query());
  if (!parsed.success) {
    return c.json({ error: 'Invalid query', details: parsed.error.flatten() }, 400);
  }
  const { limit } = parsed.data;

  // Top tags by count of public-visible, non-deleted videos. Joins via
  // idx_video_tags_tag and filters videos via idx_videos_active_created.
  const { results } = await c.env.DB.prepare(
    `SELECT t.slug, t.label, COUNT(vt.video_id) AS video_count
     FROM tags t
     JOIN video_tags vt ON vt.tag_slug = t.slug
     JOIN videos v ON v.id = vt.video_id
     WHERE v.deleted_at IS NULL AND v.hidden_at IS NULL AND v.dmca_status IS NULL
     GROUP BY t.slug
     HAVING video_count > 0
     ORDER BY video_count DESC, t.slug ASC
     LIMIT ?`,
  )
    .bind(limit)
    .all<{ slug: string; label: string; video_count: number }>();

  return c.json({ tags: results ?? [] });
});

tagRoutes.get('/api/tags/:slug', async (c) => {
  const slug = c.req.param('slug').toLowerCase();
  const parsed = tagVideosQuerySchema.safeParse(c.req.query());
  if (!parsed.success) {
    return c.json({ error: 'Invalid query', details: parsed.error.flatten() }, 400);
  }
  const { page, limit } = parsed.data;
  const offset = (page - 1) * limit;

  const tag = await c.env.DB.prepare(`SELECT slug, label FROM tags WHERE slug = ?`)
    .bind(slug)
    .first<{ slug: string; label: string }>();
  if (!tag) {
    return c.json({ error: 'Tag not found' }, 404);
  }

  const { results } = await c.env.DB.prepare(
    `SELECT v.id, v.user_id, v.title, v.description, v.thumbnail_url,
            v.view_count, v.created_at, u.name AS channel_name,
            u.username AS channel_username
     FROM videos v
     JOIN video_tags vt ON vt.video_id = v.id
     LEFT JOIN user u ON u.id = v.user_id
     WHERE vt.tag_slug = ?
       AND v.deleted_at IS NULL AND v.hidden_at IS NULL AND v.dmca_status IS NULL
     ORDER BY v.created_at DESC
     LIMIT ? OFFSET ?`,
  )
    .bind(slug, limit, offset)
    .all();

  return c.json({ tag, page, limit, videos: results ?? [] });
});

tagRoutes.get('/api/videos/:id/tags', async (c) => {
  const id = c.req.param('id');
  const { results } = await c.env.DB.prepare(
    `SELECT t.slug, t.label
     FROM video_tags vt
     JOIN tags t ON t.slug = vt.tag_slug
     WHERE vt.video_id = ?
     ORDER BY t.label ASC`,
  )
    .bind(id)
    .all<{ slug: string; label: string }>();
  return c.json({ tags: results ?? [] });
});

tagRoutes.put('/api/videos/:id/tags', async (c) => {
  const user = c.get('user');
  if (!user) return c.json({ error: 'Unauthorized' }, 401);

  const id = c.req.param('id');
  const owner = await c.env.DB.prepare(
    `SELECT user_id FROM videos WHERE id = ? AND deleted_at IS NULL`,
  )
    .bind(id)
    .first<{ user_id: string }>();
  if (!owner) return c.json({ error: 'Video not found' }, 404);
  if (owner.user_id !== user.id) return c.json({ error: 'Forbidden' }, 403);

  const json = await c.req.json().catch(() => null);
  const parsed = updateTagsBodySchema.safeParse(json);
  if (!parsed.success) {
    return c.json({ error: 'Invalid body', details: parsed.error.flatten() }, 400);
  }

  const normalised = parsed.data.tags
    .map(normaliseTagInput)
    .filter((t): t is NormalisedTag => t !== null);
  const tags = dedupeTags(normalised).slice(0, MAX_TAGS_PER_VIDEO);

  // Replace the full tag set in one batch so the row state matches the
  // request — partial updates would leave stale tags around. Tags are
  // upserted (slug is the PK) so we accumulate the global tag dictionary
  // from creator activity rather than maintaining it separately.
  const stmts: D1PreparedStatement[] = [
    c.env.DB.prepare(`DELETE FROM video_tags WHERE video_id = ?`).bind(id),
  ];
  for (const tag of tags) {
    stmts.push(
      c.env.DB.prepare(
        `INSERT INTO tags (slug, label) VALUES (?, ?)
         ON CONFLICT(slug) DO NOTHING`,
      ).bind(tag.slug, tag.label),
      c.env.DB.prepare(
        `INSERT INTO video_tags (video_id, tag_slug) VALUES (?, ?)`,
      ).bind(id, tag.slug),
    );
  }
  await c.env.DB.batch(stmts);

  // Purge the video's tag list and the global top-tags list from the edge cache.
  const origin = new URL(c.req.url).origin;
  await purgeEdgeCache([`/api/videos/${id}/tags`, '/api/tags'], origin);

  return c.json({ tags });
});

export const TAG_LIMITS = { MAX_TAGS_PER_VIDEO, TAG_LABEL_MAX } as const;
