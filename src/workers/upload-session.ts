// ALO-121: chunked upload session state.
//
// State for an in-flight multipart upload lives in the SESSIONS KV under
// three keys keyed by user id + upload id, with a 24h TTL:
//
//   upload:{userId}:{uploadId}:mpid   — R2 multipart uploadId string
//   upload:{userId}:{uploadId}:meta   — JSON: { videoId, r2Key, title, description, chunkCount, fileName?, fileSize? }
//   upload:{userId}:{uploadId}:parts  — JSON: Record<partNumber, { etag, size }>
//
// Splitting metadata/parts/uploadId across keys keeps the parts manifest
// small enough to update on every chunk write without the cost of
// re-serialising the whole session document on each PUT (KV value cap is
// 25MB but write amplification still costs us).

import { z } from 'zod';

export const UPLOAD_SESSION_TTL_SECONDS = 24 * 60 * 60;

export const uploadMetaPersistedSchema = z.object({
  videoId: z.string(),
  r2Key: z.string(),
  title: z.string(),
  description: z.string(),
  chunkCount: z.number().int().positive(),
  // Optional fingerprint fields — used by the resume status endpoint so the
  // frontend can verify the user picked the same file before resuming.
  // Older sessions without these still parse and just lack the fingerprint
  // in the status response.
  fileName: z.string().optional(),
  fileSize: z.number().int().nonnegative().optional(),
});

export type UploadMetaPersisted = z.infer<typeof uploadMetaPersistedSchema>;

export const uploadPartSchema = z.object({
  etag: z.string(),
  size: z.number().int().nonnegative(),
});

export type UploadPart = z.infer<typeof uploadPartSchema>;

export type UploadPartsMap = Record<string, UploadPart>;

export interface UploadSessionEnv {
  SESSIONS: KVNamespace;
  VIDEOS: R2Bucket;
}

export interface UploadSessionKeys {
  base: string;
  mpid: string;
  meta: string;
  parts: string;
}

export function uploadSessionKeys(userId: string, uploadId: string): UploadSessionKeys {
  const base = `upload:${userId}:${uploadId}`;
  return {
    base,
    mpid: `${base}:mpid`,
    meta: `${base}:meta`,
    parts: `${base}:parts`,
  };
}

export interface UploadSession {
  uploadId: string;
  multipartUploadId: string;
  meta: UploadMetaPersisted;
  parts: UploadPartsMap;
}

export async function readUploadSession(
  env: UploadSessionEnv,
  userId: string,
  uploadId: string,
): Promise<UploadSession | null> {
  const keys = uploadSessionKeys(userId, uploadId);
  const [multipartUploadId, metaJson, partsJson] = await Promise.all([
    env.SESSIONS.get(keys.mpid),
    env.SESSIONS.get(keys.meta),
    env.SESSIONS.get(keys.parts),
  ]);
  if (!multipartUploadId || !metaJson) return null;

  let meta: UploadMetaPersisted;
  try {
    meta = uploadMetaPersistedSchema.parse(JSON.parse(metaJson));
  } catch {
    return null;
  }

  let parts: UploadPartsMap = {};
  if (partsJson) {
    try {
      const raw = JSON.parse(partsJson) as unknown;
      if (raw && typeof raw === 'object') {
        for (const [k, v] of Object.entries(raw as Record<string, unknown>)) {
          const parsed = uploadPartSchema.safeParse(v);
          if (parsed.success) parts[k] = parsed.data;
        }
      }
    } catch {
      parts = {};
    }
  }

  return { uploadId, multipartUploadId, meta, parts };
}

// Translate the parts manifest into a 0-indexed list of chunk indices the
// server has already received, sorted ascending. The frontend uses this to
// skip already-uploaded chunks when resuming. Part numbers in R2 are
// 1-indexed; chunkIndex is 0-indexed.
export function uploadedChunkIndices(parts: UploadPartsMap): number[] {
  const indices: number[] = [];
  for (const partNumber of Object.keys(parts)) {
    const n = Number(partNumber);
    if (Number.isInteger(n) && n >= 1) {
      indices.push(n - 1);
    }
  }
  indices.sort((a, b) => a - b);
  return indices;
}

export async function deleteUploadSession(
  env: UploadSessionEnv,
  userId: string,
  uploadId: string,
): Promise<void> {
  const keys = uploadSessionKeys(userId, uploadId);
  await Promise.all([
    env.SESSIONS.delete(keys.mpid),
    env.SESSIONS.delete(keys.meta),
    env.SESSIONS.delete(keys.parts),
  ]);
}

// Best-effort R2 multipart abort + KV cleanup. Used by the explicit DELETE
// endpoint and the storage-quota safety net in videos.ts.
export async function abortUploadSession(
  env: UploadSessionEnv,
  userId: string,
  uploadId: string,
): Promise<{ aborted: boolean }> {
  const session = await readUploadSession(env, userId, uploadId);
  if (!session) {
    await deleteUploadSession(env, userId, uploadId);
    return { aborted: false };
  }
  try {
    const multipart = env.VIDEOS.resumeMultipartUpload(
      session.meta.r2Key,
      session.multipartUploadId,
    );
    await multipart.abort();
  } catch {
    // R2 abort is best-effort — the part data is uncommitted and R2's
    // lifecycle eventually reclaims it. Always clear the KV state.
  }
  await deleteUploadSession(env, userId, uploadId);
  return { aborted: true };
}
