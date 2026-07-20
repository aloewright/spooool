// ALO-E7: signed Stream playback tokens.
//
// The Stream CDN can serve any video if the caller knows the stream_video_id.
// To close that gap we set requireSignedURLs on videos that get DMCA-disabled
// and serve short-lived JWTs here so the player always goes through our
// auth/DMCA checks first.
//
// Token TTL is 1 hour — long enough for any practical viewing session; short
// enough that a DMCA disable propagates without waiting for cached UUIDs to
// expire across the CDN.
import { Hono } from 'hono';

export const STREAM_TOKEN_TTL_SECONDS = 3600;

export interface StreamTokenEnv {
  DB: D1Database;
  CLOUDFLARE_ACCOUNT_ID?: string;
  CF_STREAM_API_TOKEN?: string;
}

type SessionUser = { id: string } | null;
type StreamTokenVariables = { user: SessionUser };

export const streamTokenRoutes = new Hono<{
  Bindings: StreamTokenEnv;
  Variables: StreamTokenVariables;
}>();

streamTokenRoutes.get('/api/videos/:id/stream-token', async (c) => {
  const id = c.req.param('id');

  const video = await c.env.DB.prepare(
    `SELECT stream_video_id, status, hidden_at, dmca_status, user_id
     FROM videos
     WHERE id = ? AND deleted_at IS NULL`,
  )
    .bind(id)
    .first<{
      stream_video_id: string | null;
      status: string;
      hidden_at: string | null;
      dmca_status: string | null;
      user_id: string;
    }>();

  if (!video) return c.json({ error: 'Video not found' }, 404);

  if (video.dmca_status === 'disabled') {
    return c.json({ error: 'Unavailable for legal reasons', dmca: true }, 451);
  }

  const user = c.get('user');
  if (video.hidden_at && video.user_id !== user?.id) {
    return c.json({ error: 'Video not found' }, 404);
  }

  if (video.status !== 'ready' || !video.stream_video_id) {
    return c.json({ error: 'Stream token not available for this video' }, 404);
  }

  const token = await generateStreamToken(
    c.env.CLOUDFLARE_ACCOUNT_ID,
    c.env.CF_STREAM_API_TOKEN,
    video.stream_video_id,
  );

  if (!token) {
    // Tokens unavailable (missing credentials or Stream not enabled): fall
    // back gracefully so non-Stream deployments don't break.
    return c.json({ error: 'Stream token generation unavailable' }, 503);
  }

  const expiresAt = Math.floor(Date.now() / 1000) + STREAM_TOKEN_TTL_SECONDS;
  return c.json({ token, expiresAt });
});

export async function generateStreamToken(
  accountId: string | undefined,
  apiToken: string | undefined,
  videoUid: string,
): Promise<string | null> {
  if (!accountId || !apiToken) return null;

  const exp = Math.floor(Date.now() / 1000) + STREAM_TOKEN_TTL_SECONDS;
  const response = await fetch(
    `https://api.cloudflare.com/client/v4/accounts/${accountId}/stream/${videoUid}/token`,
    {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${apiToken}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ exp }),
    },
  );

  if (!response.ok) {
    console.error('[stream-token] Stream API token generation failed', {
      status: response.status,
      videoUid,
    });
    return null;
  }

  const data = (await response.json()) as { result?: { token?: string }; success?: boolean };
  return data.result?.token ?? null;
}

// Lock a Stream video so the bare UID no longer plays — used when a DMCA
// claim disables a video so cached UIDs stop working on the CDN immediately.
export async function restrictStreamVideo(
  accountId: string | undefined,
  apiToken: string | undefined,
  videoUid: string,
): Promise<void> {
  if (!accountId || !apiToken) return;

  const response = await fetch(
    `https://api.cloudflare.com/client/v4/accounts/${accountId}/stream/${videoUid}`,
    {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${apiToken}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ requireSignedURLs: true }),
    },
  );

  if (!response.ok) {
    // Fail-open: the DB already reflects the DMCA status. Logging is enough;
    // don't throw so the admin action doesn't surface a 502 for an upstream
    // Stream API hiccup.
    console.error('[stream-token] Failed to restrict Stream video', {
      status: response.status,
      videoUid,
    });
  }
}

// Lift the signed-URL requirement when a counter-notice restores the video.
export async function unrestrictStreamVideo(
  accountId: string | undefined,
  apiToken: string | undefined,
  videoUid: string,
): Promise<void> {
  if (!accountId || !apiToken) return;

  const response = await fetch(
    `https://api.cloudflare.com/client/v4/accounts/${accountId}/stream/${videoUid}`,
    {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${apiToken}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ requireSignedURLs: false }),
    },
  );

  if (!response.ok) {
    console.error('[stream-token] Failed to unrestrict Stream video', {
      status: response.status,
      videoUid,
    });
  }
}
