import { Hono } from 'hono';
import { z } from 'zod';
import { videoMetaCacheKey } from './video-meta-cache';

interface AnalyticsEngineDataset {
  writeDataPoint(point: { blobs?: string[]; doubles?: number[]; indexes?: string[] }): void;
}

export interface AnalyticsEnv {
  DB: D1Database;
  CACHE: KVNamespace;
  ANALYTICS?: AnalyticsEngineDataset;
}

type SessionUser = { id: string } | null;
type AnalyticsVariables = { user: SessionUser };

const SESSION_COOKIE = 'spool_view_sid';
// Treat repeated views from the same anon session+video as the same view for
// 12 hours. Logged-in users are deduped by user id over the same window.
const DEDUP_WINDOW_SECONDS = 12 * 60 * 60;

const heartbeatBodySchema = z.object({
  // Total seconds of *played* content since the last heartbeat. Capped at 60
  // because we expect pings every ~10s.
  delta: z.coerce.number().min(0).max(60),
  // Best-effort current playhead position, in seconds. Used for the
  // playhead histogram, not for billing.
  position: z.coerce.number().min(0).max(60 * 60 * 24).optional(),
});

export function readSessionCookie(cookieHeader: string | null): string | null {
  if (!cookieHeader) return null;
  const parts = cookieHeader.split(';');
  for (const part of parts) {
    const [rawName, ...rest] = part.split('=');
    if (rawName?.trim() === SESSION_COOKIE && rest.length > 0) {
      return rest.join('=').trim() || null;
    }
  }
  return null;
}

export function buildSessionCookie(sid: string): string {
  // 1 year, http-only, lax — purely for view dedup, no PII.
  return `${SESSION_COOKIE}=${sid}; Path=/; Max-Age=31536000; SameSite=Lax; HttpOnly`;
}

// Reads the dedup session id from the request cookie, or mints a new one.
// Returns the id and (when freshly minted) a Set-Cookie header value to attach
// to the response.
export function ensureSessionId(cookieHeader: string | null): {
  sid: string;
  setCookie: string | null;
} {
  const existing = readSessionCookie(cookieHeader);
  if (existing) return { sid: existing, setCookie: null };
  const sid = crypto.randomUUID();
  return { sid, setCookie: buildSessionCookie(sid) };
}

export function dedupKey(videoId: string, identity: string): string {
  return `view:${videoId}:${identity}`;
}

// Returns true if this (videoId, identity) pair counts as a fresh view.
// Updates the KV marker only when fresh.
export async function shouldCountView(
  cache: KVNamespace,
  videoId: string,
  identity: string,
): Promise<boolean> {
  const key = dedupKey(videoId, identity);
  const existing = await cache.get(key);
  if (existing) return false;
  await cache.put(key, '1', { expirationTtl: DEDUP_WINDOW_SECONDS });
  return true;
}

export const analyticsRoutes = new Hono<{
  Bindings: AnalyticsEnv;
  Variables: AnalyticsVariables;
}>();

analyticsRoutes.post('/api/videos/:id/heartbeat', async (c) => {
  const id = c.req.param('id');
  const body = await c.req.json().catch(() => null);
  const parsed = heartbeatBodySchema.safeParse(body);
  if (!parsed.success) {
    return c.json({ error: 'Invalid heartbeat', details: parsed.error.flatten() }, 400);
  }
  const { delta, position } = parsed.data;
  if (delta === 0) return c.json({ ok: true });

  // Heartbeats fire every ~10s during playback. Checking D1 on each one is
  // wasteful — ready videos are already in the KV meta cache from their initial
  // GET. A cache hit means the video is in 'ready' state and publicly viewable,
  // which is exactly the condition a playing viewer satisfies. Only fall back
  // to D1 on a cold miss (first heartbeat before the GET populates KV, or after
  // the 60s TTL lapses mid-session).
  const kvHit = await c.env.CACHE.get(videoMetaCacheKey(id));
  if (!kvHit) {
    const exists = await c.env.DB.prepare('SELECT 1 FROM videos WHERE id = ? AND deleted_at IS NULL')
      .bind(id)
      .first();
    if (!exists) return c.json({ error: 'Video not found' }, 404);
  }

  const user = c.get('user');
  const sid = readSessionCookie(c.req.header('cookie') ?? null) ?? '';

  c.env.ANALYTICS?.writeDataPoint({
    indexes: [id],
    blobs: ['watch_time', user?.id ?? '', sid],
    doubles: [delta, position ?? 0],
  });

  return c.json({ ok: true });
});
