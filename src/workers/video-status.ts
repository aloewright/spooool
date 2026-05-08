// ALO-138: canonical video lifecycle state machine.
//
// Spec: uploading -> queued -> encoding -> ready / failed.
//
// Transitions are validated at the call site via `transitionVideoStatus`.
// The helper performs the UPDATE with the predecessor in the WHERE clause,
// so the write is idempotent (no-op on same-state) and racy callers cannot
// flip a row backwards through an illegal state.

export const VIDEO_STATUSES = ['uploading', 'queued', 'encoding', 'ready', 'failed'] as const;

export type VideoStatus = (typeof VIDEO_STATUSES)[number];

export const TERMINAL_STATUSES: ReadonlySet<VideoStatus> = new Set(['ready', 'failed']);

// Allowed forward transitions. Same-state writes are always permitted
// (idempotency); they are not listed here but accepted by canTransition.
const ALLOWED: Record<VideoStatus, ReadonlySet<VideoStatus>> = {
  uploading: new Set<VideoStatus>(['queued', 'failed']),
  queued: new Set<VideoStatus>(['encoding', 'failed']),
  encoding: new Set<VideoStatus>(['ready', 'failed']),
  // `ready` may flip to `failed` if a re-encode collapses; otherwise
  // terminal. `failed` may go back to `queued` for an explicit retry.
  ready: new Set<VideoStatus>(['failed']),
  failed: new Set<VideoStatus>(['queued', 'encoding']),
};

export function isVideoStatus(value: unknown): value is VideoStatus {
  return typeof value === 'string' && (VIDEO_STATUSES as readonly string[]).includes(value);
}

export function canTransition(from: VideoStatus, to: VideoStatus): boolean {
  if (from === to) return true;
  return ALLOWED[from].has(to);
}

// Map legacy free-form status strings to the canonical alphabet so old
// rows and any in-flight writes during deploy normalise cleanly.
export function normalizeVideoStatus(raw: string | null | undefined): VideoStatus | null {
  if (!raw) return null;
  const v = raw.trim().toLowerCase();
  if (isVideoStatus(v)) return v;
  if (v === 'uploaded' || v === 'pending_encode' || v === 'stream_submitted') return 'queued';
  if (v === 'encode_failed') return 'failed';
  return null;
}

interface MinimalDB {
  prepare(query: string): {
    bind(...values: unknown[]): { run(): Promise<{ meta?: { changes?: number } }> };
  };
}

export interface TransitionResult {
  ok: boolean;
  /** Number of rows actually updated. 0 = no-op (idempotent same-state or
   *  predecessor mismatch); >0 = the transition committed. */
  changes: number;
}

/**
 * Apply a canonical status transition idempotently. The UPDATE narrows on
 * the canonical predecessor list (current state + every state that's
 * legally allowed to transition to `to`), so a stale write that arrives
 * after the row has already moved on will be a 0-row no-op rather than
 * pulling the lifecycle backwards.
 */
export async function transitionVideoStatus(
  db: MinimalDB,
  videoId: string,
  to: VideoStatus,
  extra?: { streamVideoId?: string | null },
): Promise<TransitionResult> {
  const allowedFrom = (VIDEO_STATUSES as readonly VideoStatus[]).filter((from) =>
    canTransition(from, to),
  );

  const placeholders = allowedFrom.map(() => '?').join(', ');
  const sql = `UPDATE videos
     SET status = ?,
         stream_video_id = COALESCE(?, stream_video_id),
         updated_at = CURRENT_TIMESTAMP
     WHERE id = ?
       AND status IN (${placeholders})`;

  const result = await db
    .prepare(sql)
    .bind(to, extra?.streamVideoId ?? null, videoId, ...allowedFrom)
    .run();

  const changes = result.meta?.changes ?? 0;
  return { ok: changes > 0, changes };
}
