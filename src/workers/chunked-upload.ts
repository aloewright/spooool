// ALO-134: resumable chunked upload manifest stored in KV.
//
// One KV key per upload (`upload:<userId>:<uploadId>`) holding the full
// manifest: video id, R2 key, R2 multipart upload id, original metadata,
// and the per-part etag/size map. Single-key writes keep the manifest
// atomic — the previous 3-key scheme could leave orphan state if a put()
// failed between writes.
//
// Resume flow:
//   1. Client sends chunkIndex=0 without uploadId → server creates manifest,
//      returns a fresh uploadId.
//   2. Client persists uploadId locally (sessionStorage / IndexedDB).
//   3. Subsequent chunks include uploadId so the server can append to the
//      existing R2 multipart upload.
//   4. On disconnect, the client calls GET /api/videos/upload/:id/progress
//      to discover which chunk indices the server already has, then resumes
//      uploading the missing chunks. Re-uploading an already-received
//      chunk is idempotent — R2 multipart accepts the same partNumber and
//      returns a (possibly new) etag.
//   5. The chunk that completes the manifest triggers commit-to-D1.
//
// TTL is 24h. Long enough for most pause/resume cycles, short enough that
// orphaned multipart uploads don't accumulate forever (R2 also charges for
// in-flight parts).

import { z } from 'zod';

export const UPLOAD_MANIFEST_TTL_SECONDS = 24 * 60 * 60;

const partSchema = z.object({
  etag: z.string(),
  size: z.number().int().nonnegative(),
});

export const uploadManifestSchema = z.object({
  videoId: z.string().min(1),
  r2Key: z.string().min(1),
  multipartUploadId: z.string().min(1),
  title: z.string(),
  description: z.string(),
  fileName: z.string(),
  contentType: z.string(),
  chunkCount: z.number().int().positive(),
  // Keyed by partNumber as a string (1-indexed for R2). chunkIndex N maps
  // to partNumber N+1.
  parts: z.record(z.string(), partSchema).default({}),
  createdAt: z.number().int().nonnegative(),
});

export type UploadManifest = z.infer<typeof uploadManifestSchema>;

export interface UploadManifestEnv {
  SESSIONS: KVNamespace;
}

export function manifestKey(userId: string, uploadId: string): string {
  return `upload:${userId}:${uploadId}`;
}

export function partNumberForChunkIndex(chunkIndex: number): number {
  return chunkIndex + 1;
}

export function chunkIndexForPartNumber(partNumber: number): number {
  return partNumber - 1;
}

export async function loadManifest(
  env: UploadManifestEnv,
  userId: string,
  uploadId: string,
): Promise<UploadManifest | null> {
  const raw = await env.SESSIONS.get(manifestKey(userId, uploadId));
  if (!raw) return null;
  // KV is shared, so a malformed or schema-drifted manifest is at least
  // theoretically possible — fall back to "no manifest" rather than 500.
  try {
    return uploadManifestSchema.parse(JSON.parse(raw));
  } catch {
    return null;
  }
}

export async function saveManifest(
  env: UploadManifestEnv,
  userId: string,
  uploadId: string,
  manifest: UploadManifest,
): Promise<void> {
  await env.SESSIONS.put(manifestKey(userId, uploadId), JSON.stringify(manifest), {
    expirationTtl: UPLOAD_MANIFEST_TTL_SECONDS,
  });
}

export async function deleteManifest(
  env: UploadManifestEnv,
  userId: string,
  uploadId: string,
): Promise<void> {
  await env.SESSIONS.delete(manifestKey(userId, uploadId));
}

export type UploadProgress = {
  uploadId: string;
  chunkCount: number;
  receivedChunks: number[];
  receivedBytes: number;
  // 0-indexed chunkIndex the client should send next, or null if every
  // chunk has arrived (the client should already have received the
  // commit-to-D1 response in that case).
  nextChunkIndex: number | null;
  complete: boolean;
};

export function manifestProgress(uploadId: string, manifest: UploadManifest): UploadProgress {
  const indices: number[] = [];
  let bytes = 0;
  for (const [partNumber, part] of Object.entries(manifest.parts)) {
    indices.push(chunkIndexForPartNumber(Number(partNumber)));
    bytes += part.size;
  }
  indices.sort((a, b) => a - b);
  // Linear scan to find the first gap. Walks the sorted indices once, so
  // this is O(N) — earlier reviewers flagged an O(N²) variant that used
  // includes() inside a loop over [0, chunkCount).
  let nextChunkIndex: number | null = null;
  let cursor = 0;
  for (const idx of indices) {
    if (idx !== cursor) {
      nextChunkIndex = cursor;
      break;
    }
    cursor += 1;
  }
  if (nextChunkIndex === null && cursor < manifest.chunkCount) {
    nextChunkIndex = cursor;
  }
  return {
    uploadId,
    chunkCount: manifest.chunkCount,
    receivedChunks: indices,
    receivedBytes: bytes,
    nextChunkIndex,
    complete: indices.length === manifest.chunkCount,
  };
}

export function totalBytesInManifest(manifest: UploadManifest): number {
  let bytes = 0;
  for (const part of Object.values(manifest.parts)) {
    bytes += part.size;
  }
  return bytes;
}

export function completedPartsForR2(
  manifest: UploadManifest,
): Array<{ partNumber: number; etag: string }> {
  return Object.entries(manifest.parts)
    .map(([partNumber, part]) => ({ partNumber: Number(partNumber), etag: part.etag }))
    .sort((a, b) => a.partNumber - b.partNumber);
}
