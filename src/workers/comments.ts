import { Hono } from 'hono';
import { z } from 'zod';
import { isLikelySpam } from './spam-filter';
import { sendCommentNotificationEmail } from './notification-email';
import { waitUntilBackground } from './wait-until';

export interface CommentsEnv {
  DB: D1Database;
  EMAIL?: import('./email').EmailBinding;
  EMAIL_FROM?: string;
  EMAIL_FROM_NAME?: string;
}

type SessionUser = { id: string; name?: string } | null;
type CommentsVariables = { user: SessionUser };

const COMMENT_BODY_MAX = 4_000;

const commentBodySchema = z.object({
  body: z.string().trim().min(1).max(COMMENT_BODY_MAX),
  parentCommentId: z.string().min(1).max(64).optional().nullable(),
});

const commentEditSchema = z.object({
  body: z.string().trim().min(1).max(COMMENT_BODY_MAX),
});

const listQuerySchema = z.object({
  sort: z.enum(['new', 'top']).default('new'),
  limit: z.coerce.number().int().positive().max(100).default(50),
  page: z.coerce.number().int().positive().default(1),
});

interface CommentRow {
  id: string;
  video_id: string;
  user_id: string;
  parent_comment_id: string | null;
  body: string;
  created_at: string;
  updated_at: string;
  deleted_at: string | null;
  author_name: string | null;
  author_username: string | null;
  reply_count: number;
}

export const commentRoutes = new Hono<{
  Bindings: CommentsEnv;
  Variables: CommentsVariables;
}>();

commentRoutes.get('/api/videos/:id/comments', async (c) => {
  const videoId = c.req.param('id');
  const parsed = listQuerySchema.safeParse(c.req.query());
  if (!parsed.success) {
    return c.json({ error: 'Invalid query parameters', details: parsed.error.flatten() }, 400);
  }
  const { sort, limit, page } = parsed.data;
  const offset = (page - 1) * limit;

  const orderClause =
    sort === 'top'
      ? 'reply_count DESC, c.created_at DESC'
      : 'c.created_at DESC';

  // Top-level comments + each one's reply_count.
  const top = await c.env.DB.prepare(
    `SELECT c.id, c.video_id, c.user_id, c.parent_comment_id, c.body,
            c.created_at, c.updated_at, c.deleted_at,
            u.name AS author_name, u.username AS author_username,
            (SELECT COUNT(*) FROM comments r
              WHERE r.parent_comment_id = c.id AND r.deleted_at IS NULL) AS reply_count
     FROM comments c
     LEFT JOIN user u ON u.id = c.user_id
     WHERE c.video_id = ? AND c.parent_comment_id IS NULL AND c.deleted_at IS NULL
     ORDER BY ${orderClause}
     LIMIT ? OFFSET ?`,
  )
    .bind(videoId, limit, offset)
    .all<CommentRow>();

  const topRows = top.results ?? [];
  if (topRows.length === 0) return c.json({ comments: [], page, limit, sort });

  const ids = topRows.map((r) => r.id);
  const placeholders = ids.map(() => '?').join(',');
  const replies = await c.env.DB.prepare(
    `SELECT c.id, c.video_id, c.user_id, c.parent_comment_id, c.body,
            c.created_at, c.updated_at, c.deleted_at,
            u.name AS author_name, u.username AS author_username,
            0 AS reply_count
     FROM comments c
     LEFT JOIN user u ON u.id = c.user_id
     WHERE c.parent_comment_id IN (${placeholders}) AND c.deleted_at IS NULL
     ORDER BY c.created_at ASC`,
  )
    .bind(...ids)
    .all<CommentRow>();

  const replyRows = replies.results ?? [];
  const repliesByParent = new Map<string, CommentRow[]>();
  for (const r of replyRows) {
    const list = repliesByParent.get(r.parent_comment_id ?? '') ?? [];
    list.push(r);
    repliesByParent.set(r.parent_comment_id ?? '', list);
  }

  const shaped = topRows.map((r) => ({
    id: r.id,
    body: r.body,
    user_id: r.user_id,
    author_name: r.author_name,
    author_username: r.author_username,
    parent_comment_id: null,
    reply_count: Number(r.reply_count ?? 0),
    created_at: r.created_at,
    updated_at: r.updated_at,
    edited: r.updated_at !== r.created_at,
    replies: (repliesByParent.get(r.id) ?? []).map((rep) => ({
      id: rep.id,
      body: rep.body,
      user_id: rep.user_id,
      author_name: rep.author_name,
      author_username: rep.author_username,
      parent_comment_id: rep.parent_comment_id,
      created_at: rep.created_at,
      updated_at: rep.updated_at,
      edited: rep.updated_at !== rep.created_at,
    })),
  }));

  return c.json({ comments: shaped, page, limit, sort });
});

commentRoutes.post('/api/videos/:id/comments', async (c) => {
  const user = c.get('user');
  if (!user) return c.json({ error: 'Unauthorized' }, 401);

  const videoId = c.req.param('id');
  const json = await c.req.json().catch(() => null);
  const parsed = commentBodySchema.safeParse(json);
  if (!parsed.success) {
    return c.json({ error: 'Invalid comment', details: parsed.error.flatten() }, 400);
  }
  const { body, parentCommentId } = parsed.data;
  const trimmed = body.trim();

  const spam = isLikelySpam(trimmed);
  if (spam.blocked) {
    return c.json({ error: 'Comment blocked', code: spam.reason ?? 'spam' }, 422);
  }

  const video = await c.env.DB.prepare(
    'SELECT 1 FROM videos WHERE id = ? AND deleted_at IS NULL',
  )
    .bind(videoId)
    .first();
  if (!video) return c.json({ error: 'Video not found' }, 404);

  let resolvedParent: string | null = null;
  if (parentCommentId) {
    const parent = await c.env.DB.prepare(
      `SELECT id, parent_comment_id FROM comments
       WHERE id = ? AND video_id = ? AND deleted_at IS NULL`,
    )
      .bind(parentCommentId, videoId)
      .first<{ id: string; parent_comment_id: string | null }>();
    if (!parent) return c.json({ error: 'Parent comment not found' }, 404);
    if (parent.parent_comment_id !== null) {
      return c.json({ error: 'Replies are limited to one level deep' }, 400);
    }
    resolvedParent = parent.id;
  }

  const owner = await c.env.DB.prepare(
    `SELECT v.user_id, v.title, u.name AS commenter_name
     FROM videos v
     LEFT JOIN user u ON u.id = ?
     WHERE v.id = ? AND v.deleted_at IS NULL`,
  )
    .bind(user.id, videoId)
    .first<{ user_id: string; title: string; commenter_name: string | null }>();

  const id = crypto.randomUUID();
  await c.env.DB.prepare(
    `INSERT INTO comments (id, video_id, user_id, parent_comment_id, body, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)`,
  )
    .bind(id, videoId, user.id, resolvedParent, trimmed)
    .run();

  if (owner && owner.user_id !== user.id) {
    waitUntilBackground(c, sendCommentNotificationEmail(c.env, {
      ownerUserId: owner.user_id,
      commenterName: owner.commenter_name ?? user.name ?? 'Someone',
      videoId,
      videoTitle: owner.title,
      excerpt: trimmed,
      origin: new URL(c.req.url).origin,
    }).catch((err) => {
      console.warn('comment email failed', { videoId, error: err instanceof Error ? err.message : String(err) });
    }));
  }

  return c.json({ id, body: trimmed, parent_comment_id: resolvedParent }, 201);
});

commentRoutes.patch('/api/comments/:commentId', async (c) => {
  const user = c.get('user');
  if (!user) return c.json({ error: 'Unauthorized' }, 401);

  const commentId = c.req.param('commentId');
  const json = await c.req.json().catch(() => null);
  const parsed = commentEditSchema.safeParse(json);
  if (!parsed.success) {
    return c.json({ error: 'Invalid comment', details: parsed.error.flatten() }, 400);
  }
  const trimmed = parsed.data.body.trim();

  const spam = isLikelySpam(trimmed);
  if (spam.blocked) {
    return c.json({ error: 'Comment blocked', code: spam.reason ?? 'spam' }, 422);
  }

  const existing = await c.env.DB.prepare(
    'SELECT id, user_id, deleted_at FROM comments WHERE id = ?',
  )
    .bind(commentId)
    .first<{ id: string; user_id: string; deleted_at: string | null }>();
  if (!existing || existing.deleted_at) {
    return c.json({ error: 'Comment not found' }, 404);
  }
  if (existing.user_id !== user.id) {
    return c.json({ error: 'Forbidden' }, 403);
  }

  await c.env.DB.prepare(
    'UPDATE comments SET body = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?',
  )
    .bind(trimmed, commentId)
    .run();
  return c.json({ id: commentId, body: trimmed });
});

commentRoutes.delete('/api/comments/:commentId', async (c) => {
  const user = c.get('user');
  if (!user) return c.json({ error: 'Unauthorized' }, 401);

  const commentId = c.req.param('commentId');
  const existing = await c.env.DB.prepare(
    'SELECT id, user_id, deleted_at FROM comments WHERE id = ?',
  )
    .bind(commentId)
    .first<{ id: string; user_id: string; deleted_at: string | null }>();
  if (!existing || existing.deleted_at) {
    return c.json({ error: 'Comment not found' }, 404);
  }
  if (existing.user_id !== user.id) {
    return c.json({ error: 'Forbidden' }, 403);
  }

  await c.env.DB.prepare(
    `UPDATE comments
     SET deleted_at = CURRENT_TIMESTAMP, body = '', updated_at = CURRENT_TIMESTAMP
     WHERE id = ?`,
  )
    .bind(commentId)
    .run();
  return c.json({ id: commentId, deleted: true });
});
