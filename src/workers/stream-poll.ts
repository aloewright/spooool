// Polling fallback for the Stream → webhook callback path.
//
// Webhooks are best-effort: secrets rotate, our worker can be down for a
// minute, the network can drop the request. Without a poll, a row that
// missed its callback would sit in `encoding` forever and the watch page
// would never show a playable HLS URL.
//
// `pollStuckEncodings` finds every row that's been in `encoding` for more
// than `STUCK_AFTER_SECONDS` and asks Cloudflare Stream for the truth.
// On success it persists the HLS manifest URL and flips status; on failure
// it transitions to `failed` so the user sees a useful error instead of a
// permanently-spinning watch page.

import { buildThumbnailCandidates } from './thumbnails';
import { canTransition, VIDEO_STATUSES, type VideoStatus } from './video-status';
import { mapStreamState } from './stream-webhook';

export interface StreamPollEnv {
  DB: D1Database;
  STREAM_ENABLED?: string;
  CLOUDFLARE_ACCOUNT_ID?: string;
  CF_STREAM_API_TOKEN?: string;
}

// Stream's HLS encode for an SD/HD upload is usually well under 5 minutes.
// Poll anything that's been stuck longer than that — small enough to be a
// useful safety net, large enough that we don't race the webhook on the
// happy path.
export const STUCK_AFTER_SECONDS = 5 * 60;

export const POLL_BATCH_LIMIT = 25;

export interface StreamPollResult {
  videoId: string;
  streamVideoId: string;
  status: VideoStatus;
  changes: number;
  error?: string;
}

interface StreamGetResponse {
  success?: boolean;
  result?: {
    uid?: string;
    status?: { state?: string; errorReasonText?: string };
    playback?: { hls?: string; dash?: string };
    thumbnail?: string;
    duration?: number;
  };
  errors?: { code?: number; message?: string }[];
}

interface StuckRow {
  id: string;
  stream_video_id: string;
}

async function fetchStreamRow(
  env: StreamPollEnv,
  streamVideoId: string,
): Promise<StreamGetResponse> {
  const accountId = env.CLOUDFLARE_ACCOUNT_ID;
  const apiToken = env.CF_STREAM_API_TOKEN;
  if (!accountId || !apiToken) {
    throw new Error('Stream poll needs CLOUDFLARE_ACCOUNT_ID and CF_STREAM_API_TOKEN');
  }
  const res = await fetch(
    `https://api.cloudflare.com/client/v4/accounts/${accountId}/stream/${encodeURIComponent(
      streamVideoId,
    )}`,
    {
      headers: {
        Authorization: `Bearer ${apiToken}`,
      },
    },
  );
  if (!res.ok) {
    const text = await res.text().catch(() => '');
    throw new Error(`Stream GET failed: ${res.status} ${text}`);
  }
  return (await res.json().catch(() => ({}))) as StreamGetResponse;
}

export async function pollStuckEncodings(
  env: StreamPollEnv,
  nowMs: number = Date.now(),
): Promise<StreamPollResult[]> {
  if (env.STREAM_ENABLED !== 'true') return [];

  const cutoffIso = new Date(nowMs - STUCK_AFTER_SECONDS * 1000).toISOString();

  const due = await env.DB.prepare(
    `SELECT id, stream_video_id
     FROM videos
     WHERE status = 'encoding'
       AND stream_video_id IS NOT NULL
       AND updated_at <= ?
     ORDER BY updated_at ASC
     LIMIT ?`,
  )
    .bind(cutoffIso, POLL_BATCH_LIMIT)
    .all<StuckRow>();

  const rows = due.results ?? [];
  const out: StreamPollResult[] = [];

  for (const row of rows) {
    try {
      const data = await fetchStreamRow(env, row.stream_video_id);
      const state = data.result?.status?.state;
      if (!state) {
        out.push({
          videoId: row.id,
          streamVideoId: row.stream_video_id,
          status: 'encoding',
          changes: 0,
          error: data.errors?.[0]?.message ?? 'missing status.state',
        });
        continue;
      }
      const status = mapStreamState(state);
      const playbackHls = data.result?.playback?.hls ?? null;
      const thumbnail = data.result?.thumbnail ?? null;
      const candidates =
        status === 'ready'
          ? JSON.stringify(
              buildThumbnailCandidates(row.stream_video_id, data.result?.duration),
            )
          : null;

      const allowedFrom = (VIDEO_STATUSES as readonly VideoStatus[]).filter((from) =>
        canTransition(from, status),
      );
      const placeholders = allowedFrom.map(() => '?').join(', ');
      const result = await env.DB.prepare(
        `UPDATE videos
         SET status = ?,
             playback_hls_url = COALESCE(?, playback_hls_url),
             thumbnail_url = COALESCE(?, thumbnail_url),
             thumbnail_candidates = COALESCE(?, thumbnail_candidates),
             updated_at = CURRENT_TIMESTAMP
         WHERE id = ?
           AND status IN (${placeholders})`,
      )
        .bind(status, playbackHls, thumbnail, candidates, row.id, ...allowedFrom)
        .run();

      const changes = (result.meta?.changes as number | undefined) ?? 0;
      out.push({
        videoId: row.id,
        streamVideoId: row.stream_video_id,
        status,
        changes,
      });
    } catch (error) {
      out.push({
        videoId: row.id,
        streamVideoId: row.stream_video_id,
        status: 'encoding',
        changes: 0,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  return out;
}
