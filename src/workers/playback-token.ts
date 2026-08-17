// Signed playback tokens for R2-backed HLS content (E7 abuse defense).
//
// R2 buckets are private (Workers-only), so direct object access is already
// impossible. These tokens add a second layer: the HLS proxy refuses to serve
// manifests and segments unless the request carries a valid short-lived token.
// This prevents hotlinking of HLS URLs and makes bookmarked segment URLs
// self-expire after 4 hours.
//
// Design:
// - Symmetric HMAC-SHA256 JWT, secret derived from BETTER_AUTH_SECRET so no
//   new secret needs to be provisioned.
// - Token encodes only the video ID (`vid` claim) and expiry (`exp`). No user
//   ID — the issuance endpoint already enforces visibility; the token itself is
//   a proof of "you were allowed to start a session for this video at t=now".
// - 4-hour TTL: long enough for a multi-hour recording; short enough that a
//   scraped URL becomes useless quickly.
// - Issuance is fail-open for public videos (no auth needed), fail-closed for
//   hidden videos (owner session required). The HLS proxy is fail-closed: no
//   token → 401.
//
// M3U8 rewriting:
// - When the proxy serves a playlist, it rewrites all relative URL lines to
//   absolute Worker paths that include `?t=<token>`. This propagates the token
//   to every subsequent segment/sub-playlist request automatically, so the
//   caller only needs to embed the token in the master manifest URL.

import { Hono } from 'hono';
import { SignJWT, jwtVerify } from 'jose';

export interface PlaybackTokenEnv {
  DB: D1Database;
  BETTER_AUTH_SECRET?: string;
}

type SessionUser = { id: string } | null;
type PlaybackTokenVariables = { user: SessionUser };

export const TOKEN_TTL_SECONDS = 4 * 60 * 60;

// Derive a playback-specific key from the auth secret so the two
// token spaces are independent even though they share the same root secret.
function tokenBytes(env: PlaybackTokenEnv): Uint8Array {
  return new TextEncoder().encode(`pb:${env.BETTER_AUTH_SECRET ?? 'dev-playback-secret'}`);
}

export async function signPlaybackToken(videoId: string, env: PlaybackTokenEnv): Promise<string> {
  return new SignJWT({ vid: videoId })
    .setProtectedHeader({ alg: 'HS256' })
    .setIssuedAt()
    .setExpirationTime(`${TOKEN_TTL_SECONDS}s`)
    .sign(tokenBytes(env));
}

export interface VerifyResult {
  valid: boolean;
  reason?: string;
}

export async function verifyPlaybackToken(
  token: string,
  videoId: string,
  env: PlaybackTokenEnv,
): Promise<VerifyResult> {
  try {
    const { payload } = await jwtVerify(token, tokenBytes(env));
    if (payload.vid !== videoId) return { valid: false, reason: 'video mismatch' };
    return { valid: true };
  } catch (err) {
    return { valid: false, reason: err instanceof Error ? err.message : 'invalid token' };
  }
}

// Rewrite non-comment lines in an HLS manifest to absolute Worker URLs that
// carry the playback token. This makes every subsequent segment/sub-playlist
// request self-authenticating without the player needing to add the token.
//
// `restDir` is the directory portion of the manifest's R2 key suffix, e.g.
//   master.m3u8       → restDir = ''
//   720p/index.m3u8  → restDir = '720p/'
//
// Lines that already carry an absolute https:// URL get the token appended as
// a query parameter rather than being rewritten (handles edge cases where the
// encoder emits absolute segment URLs).
export function rewriteM3u8(
  content: string,
  videoId: string,
  restDir: string,
  token: string,
  origin: string,
): string {
  const base = `${origin}/api/videos/${videoId}/hls/${restDir}`;
  return content
    .split('\n')
    .map((line) => {
      const trimmed = line.trim();
      // Preserve comment lines, empty lines, and blank-whitespace lines.
      if (!trimmed || trimmed.startsWith('#')) return line;

      if (trimmed.startsWith('https://') || trimmed.startsWith('http://')) {
        try {
          const u = new URL(trimmed);
          u.searchParams.set('t', token);
          return u.toString();
        } catch {
          return line;
        }
      }

      // Relative URL — strip any existing '?' so we can append cleanly, then
      // separate the path from any existing query string.
      const [path, qs] = trimmed.split('?');
      const extra = qs ? `&${qs}` : '';
      return `${base}${path}?t=${token}${extra}`;
    })
    .join('\n');
}

export const playbackTokenRoutes = new Hono<{
  Bindings: PlaybackTokenEnv;
  Variables: PlaybackTokenVariables;
}>();

// POST /api/videos/:id/playback-token
// Issues a short-lived JWT for HLS playback. No auth required for public
// videos; owner auth required for hidden ones.
playbackTokenRoutes.post('/api/videos/:id/playback-token', async (c) => {
  const id = c.req.param('id');

  const video = await c.env.DB.prepare(
    `SELECT hidden_at, user_id, dmca_status
     FROM videos WHERE id = ? AND deleted_at IS NULL`,
  )
    .bind(id)
    .first<{ hidden_at: string | null; user_id: string; dmca_status: string | null }>();

  if (!video) return c.json({ error: 'Video not found' }, 404);
  if (video.dmca_status === 'disabled') {
    return c.json({ error: 'Unavailable for legal reasons', dmca: true }, 451);
  }

  const user = c.get('user');
  if (video.hidden_at && video.user_id !== user?.id) {
    return c.json({ error: 'Video not found' }, 404);
  }

  const token = await signPlaybackToken(id, c.env);
  return c.json({ token, ttl: TOKEN_TTL_SECONDS });
});
