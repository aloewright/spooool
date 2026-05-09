// ALO-122 (E3): per-video WebVTT caption tracks. Owners upload sidecar
// VTT files, viewers get them rendered as <track kind="subtitles"> elements
// alongside the <video> tag. Tracks live in R2 under
// `${user_id}/${video_id}/captions/${language}.vtt`; D1 holds metadata.
//
// Endpoints:
//   GET    /api/videos/:id/captions               — list available tracks
//   GET    /api/videos/:id/captions/:lang.vtt     — serve VTT body (public)
//   PUT    /api/videos/:id/captions/:lang         — owner upload (text body)
//   DELETE /api/videos/:id/captions/:lang         — owner delete
//
// Caption upload bodies are validated against a leading `WEBVTT` header so
// we can't be tricked into hosting arbitrary text content under our R2
// origin.

import { Hono } from 'hono';
import { z } from 'zod';

export interface CaptionsEnv {
  DB: D1Database;
  VIDEOS: R2Bucket;
}

type SessionUser = { id: string } | null;
type CaptionsVariables = { user: SessionUser };

const MAX_VTT_BYTES = 2 * 1024 * 1024; // 2 MiB — generous for very long videos.
// BCP-47 language tag, loosened: lowercase letters and dashes, 2-12 chars.
// Covers en, en-us, zh-hans, etc. without bringing in a full BCP-47 parser.
const LANGUAGE_RE = /^[a-z]{2,3}(?:-[a-z0-9]{2,8})?$/i;

const uploadHeadersSchema = z.object({
  label: z.string().min(1).max(64),
  isDefault: z
    .union([z.literal('true'), z.literal('false'), z.literal('1'), z.literal('0')])
    .optional(),
});

export interface CaptionRow {
  language: string;
  label: string;
  r2_key: string;
  is_default: number;
  bytes: number;
  updated_at: string;
}

export function captionR2Key(userId: string, videoId: string, language: string): string {
  return `${userId}/${videoId}/captions/${language}.vtt`;
}

// We accept either CRLF or LF line endings; some editors emit BOM. Strip BOM
// before checking so a UTF-8 BOM-prefixed file still validates.
export function isValidWebVtt(body: string): boolean {
  const trimmed = body.replace(/^﻿/, '');
  // Spec: file must start with the literal "WEBVTT" optionally followed by a
  // tab/space and a header comment, then a newline.
  return /^WEBVTT(?:[\t ][^\n\r]*)?\r?\n/.test(trimmed);
}

export function normalizeLanguage(raw: string): string | null {
  const lower = raw.trim().toLowerCase();
  if (!LANGUAGE_RE.test(lower)) return null;
  return lower;
}

async function loadVideoOwner(
  db: D1Database,
  videoId: string,
): Promise<{ user_id: string } | null> {
  return await db
    .prepare('SELECT user_id FROM videos WHERE id = ? AND deleted_at IS NULL')
    .bind(videoId)
    .first<{ user_id: string }>();
}

export const captionsRoutes = new Hono<{
  Bindings: CaptionsEnv;
  Variables: CaptionsVariables;
}>();

captionsRoutes.get('/api/videos/:id/captions', async (c) => {
  const id = c.req.param('id');
  const exists = await c.env.DB.prepare(
    'SELECT 1 FROM videos WHERE id = ? AND deleted_at IS NULL',
  )
    .bind(id)
    .first();
  if (!exists) return c.json({ error: 'Video not found' }, 404);

  const { results } = await c.env.DB.prepare(
    `SELECT language, label, is_default, bytes, updated_at
     FROM video_captions
     WHERE video_id = ?
     ORDER BY is_default DESC, language ASC`,
  )
    .bind(id)
    .all<Pick<CaptionRow, 'language' | 'label' | 'is_default' | 'bytes' | 'updated_at'>>();

  const tracks = (results ?? []).map((row) => ({
    language: row.language,
    label: row.label,
    isDefault: row.is_default === 1,
    bytes: Number(row.bytes ?? 0),
    src: `/api/videos/${encodeURIComponent(id)}/captions/${encodeURIComponent(row.language)}.vtt`,
    updatedAt: row.updated_at,
  }));

  return c.json({ tracks });
});

captionsRoutes.on(['GET', 'HEAD'], '/api/videos/:id/captions/:file', async (c) => {
  const id = c.req.param('id');
  const file = c.req.param('file');
  // The route param includes the .vtt suffix so the browser pulls it from a
  // canonical URL; reject anything else so we don't leak unrelated objects.
  if (!file.endsWith('.vtt')) {
    return c.json({ error: 'Not found' }, 404);
  }
  const language = normalizeLanguage(file.slice(0, -'.vtt'.length));
  if (!language) {
    return c.json({ error: 'Invalid language' }, 400);
  }

  const row = await c.env.DB.prepare(
    `SELECT v.user_id, v.deleted_at, c.r2_key
     FROM video_captions c
     JOIN videos v ON v.id = c.video_id
     WHERE c.video_id = ? AND c.language = ?`,
  )
    .bind(id, language)
    .first<{ user_id: string; deleted_at: string | null; r2_key: string }>();
  if (!row || row.deleted_at) {
    return c.json({ error: 'Caption not found' }, 404);
  }

  const head = await c.env.VIDEOS.head(row.r2_key);
  if (!head) {
    return c.json({ error: 'Caption object missing' }, 404);
  }

  if (c.req.method === 'HEAD') {
    return new Response(null, {
      status: 200,
      headers: {
        'Content-Type': 'text/vtt; charset=utf-8',
        'Content-Length': String(head.size),
        'Cache-Control': 'public, max-age=300',
      },
    });
  }

  const object = await c.env.VIDEOS.get(row.r2_key);
  if (!object) {
    return c.json({ error: 'Caption object missing' }, 404);
  }
  return new Response(object.body, {
    status: 200,
    headers: {
      'Content-Type': 'text/vtt; charset=utf-8',
      'Content-Length': String(head.size),
      'Cache-Control': 'public, max-age=300',
    },
  });
});

captionsRoutes.put('/api/videos/:id/captions/:lang', async (c) => {
  const user = c.get('user');
  if (!user) return c.json({ error: 'Unauthorized' }, 401);

  const id = c.req.param('id');
  const language = normalizeLanguage(c.req.param('lang'));
  if (!language) {
    return c.json({ error: 'Invalid language tag' }, 400);
  }

  const owner = await loadVideoOwner(c.env.DB, id);
  if (!owner) return c.json({ error: 'Video not found' }, 404);
  if (owner.user_id !== user.id) {
    return c.json({ error: 'Forbidden' }, 403);
  }

  const headerParse = uploadHeadersSchema.safeParse({
    label: c.req.header('x-caption-label') ?? '',
    isDefault: c.req.header('x-caption-default') ?? undefined,
  });
  if (!headerParse.success) {
    return c.json(
      { error: 'Invalid caption headers', details: headerParse.error.flatten() },
      400,
    );
  }
  const { label } = headerParse.data;
  const isDefault =
    headerParse.data.isDefault === 'true' || headerParse.data.isDefault === '1';

  const body = await c.req.text();
  // Reject before paying the R2 PUT.
  const bytes = new TextEncoder().encode(body).byteLength;
  if (bytes === 0) {
    return c.json({ error: 'Empty caption body' }, 400);
  }
  if (bytes > MAX_VTT_BYTES) {
    return c.json({ error: 'Caption too large', code: 'caption_too_large' }, 413);
  }
  if (!isValidWebVtt(body)) {
    return c.json({ error: 'Body must be a valid WebVTT file', code: 'invalid_webvtt' }, 400);
  }

  const r2Key = captionR2Key(user.id, id, language);
  await c.env.VIDEOS.put(r2Key, body, {
    httpMetadata: { contentType: 'text/vtt; charset=utf-8' },
  });

  // If the caller marked this track as default, clear other defaults so the
  // player only sees one. Otherwise leave the existing flag alone — re-uploads
  // shouldn't silently demote the default. Wrap the clear+upsert in a single
  // D1 batch so two concurrent PUTs can't both win the "is default" race.
  const statements: D1PreparedStatement[] = [];
  if (isDefault) {
    statements.push(
      c.env.DB.prepare(
        'UPDATE video_captions SET is_default = 0 WHERE video_id = ? AND language != ?',
      ).bind(id, language),
    );
  }
  statements.push(
    c.env.DB.prepare(
      `INSERT INTO video_captions (video_id, language, label, r2_key, is_default, bytes, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)
       ON CONFLICT(video_id, language) DO UPDATE SET
         label = excluded.label,
         r2_key = excluded.r2_key,
         is_default = CASE WHEN ? = 1 THEN 1 ELSE video_captions.is_default END,
         bytes = excluded.bytes,
         updated_at = CURRENT_TIMESTAMP`,
    ).bind(id, language, label, r2Key, isDefault ? 1 : 0, bytes, isDefault ? 1 : 0),
  );
  await c.env.DB.batch(statements);

  return c.json({
    language,
    label,
    isDefault,
    bytes,
    src: `/api/videos/${encodeURIComponent(id)}/captions/${encodeURIComponent(language)}.vtt`,
  });
});

captionsRoutes.delete('/api/videos/:id/captions/:lang', async (c) => {
  const user = c.get('user');
  if (!user) return c.json({ error: 'Unauthorized' }, 401);

  const id = c.req.param('id');
  const language = normalizeLanguage(c.req.param('lang'));
  if (!language) {
    return c.json({ error: 'Invalid language tag' }, 400);
  }

  const owner = await loadVideoOwner(c.env.DB, id);
  if (!owner) return c.json({ error: 'Video not found' }, 404);
  if (owner.user_id !== user.id) {
    return c.json({ error: 'Forbidden' }, 403);
  }

  const row = await c.env.DB.prepare(
    'SELECT r2_key FROM video_captions WHERE video_id = ? AND language = ?',
  )
    .bind(id, language)
    .first<{ r2_key: string }>();

  // Delete is idempotent — return 204 even if there was nothing to delete.
  if (row) {
    await c.env.VIDEOS.delete(row.r2_key);
    await c.env.DB.prepare(
      'DELETE FROM video_captions WHERE video_id = ? AND language = ?',
    )
      .bind(id, language)
      .run();
  }

  return new Response(null, { status: 204 });
});
