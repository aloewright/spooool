// ALO-135: polling reconciliation for Cloudflare Stream encoding jobs.
//
// The webhook (stream-webhook.ts) is the primary signal that a Stream
// upload has finished encoding. Webhooks can be lost — Stream may drop
// deliveries, our worker may have been mid-deploy when the event fired,
// or signature verification may have rejected a malformed retry. This
// module is the safety net: a scheduled sweep reads videos still stuck
// in `encoding`, polls the Stream REST API for each, and applies the
// same status mapping the webhook would have.

import { buildThumbnailCandidates } from './thumbnails';
import { VIDEO_STATUSES, canTransition, type VideoStatus } from './video-status';
import { mapStreamState } from './stream-webhook';

export interface StreamPollEnv {
  DB: D1Database;
  CLOUDFLARE_ACCOUNT_ID?: string;
  CF_STREAM_API_TOKEN?: string;
}

export interface StreamPollDeps {
  fetch?: typeof fetch;
  /** Max rows to reconcile per sweep — keeps the cron bounded. */
  limit?: number;
}

export interface StreamPollResult {
  scanned: number;
  updated: number;
  errors: number;
}

interface EncodingRow {
  id: string;
  stream_video_id: string;
}

interface StreamApiResponse {
  result?: {
    uid?: string;
    status?: { state?: string };
    playback?: { hls?: string; dash?: string };
    thumbnail?: string;
    duration?: number;
  };
}

export async function pollStreamForEncodingVideos(
  env: StreamPollEnv,
  deps: StreamPollDeps = {},
): Promise<StreamPollResult> {
  const accountId = env.CLOUDFLARE_ACCOUNT_ID;
  const apiToken = env.CF_STREAM_API_TOKEN;
  if (!accountId || !apiToken) {
    return { scanned: 0, updated: 0, errors: 0 };
  }

  const fetchImpl = deps.fetch ?? fetch;
  const limit = deps.limit ?? 25;

  const rows = await env.DB.prepare(
    `SELECT id, stream_video_id FROM videos
     WHERE status = 'encoding'
       AND stream_video_id IS NOT NULL
     ORDER BY updated_at ASC
     LIMIT ?`,
  )
    .bind(limit)
    .all<EncodingRow>();

  const candidates = (rows.results ?? []).filter((r) => r.stream_video_id);

  let updated = 0;
  let errors = 0;
  for (const row of candidates) {
    try {
      const res = await fetchImpl(
        `https://api.cloudflare.com/client/v4/accounts/${accountId}/stream/${row.stream_video_id}`,
        {
          method: 'GET',
          headers: { Authorization: `Bearer ${apiToken}` },
        },
      );
      if (!res.ok) {
        errors++;
        continue;
      }
      const data = (await res.json()) as StreamApiResponse;
      const state = data.result?.status?.state;
      if (!state) {
        errors++;
        continue;
      }
      const next: VideoStatus = mapStreamState(state);
      const playbackHls = data.result?.playback?.hls ?? null;
      const thumbnail = data.result?.thumbnail ?? null;
      const candidatesJson =
        next === 'ready'
          ? JSON.stringify(buildThumbnailCandidates(row.stream_video_id, data.result?.duration))
          : null;

      const allowedFrom = (VIDEO_STATUSES as readonly VideoStatus[]).filter((from) =>
        canTransition(from, next),
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
        .bind(next, playbackHls, thumbnail, candidatesJson, row.id, ...allowedFrom)
        .run();
      const changes = (result.meta?.changes as number | undefined) ?? 0;
      if (changes > 0) updated++;
    } catch {
      errors++;
    }
  }

  return { scanned: candidates.length, updated, errors };
}
