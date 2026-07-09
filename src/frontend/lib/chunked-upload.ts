// Shared chunked uploader for both /upload (file picker) and /record
// (recorder takes). The endpoint accepts multipart/form-data with one chunk
// per request and returns { uploadId } so subsequent chunks can be stitched
// server-side. Kept framework-free so it can be imported from any component.

export const CHUNK_SIZE = 10 * 1024 * 1024;

// Retry config: up to 3 retries on 5xx and network errors.
// Delays: 1s, 2s, 4s (exponential backoff, capped at 4s per attempt).
const MAX_CHUNK_RETRIES = 3;
const RETRY_BASE_MS = 1000;

export type UploadTarget = 'video' | 'recorder';

export interface UploadOptions {
  file: Blob;
  endpoint: string;
  target: UploadTarget;
  /** Extra form fields merged into every chunk request. */
  fields?: Record<string, string>;
  /** Extra headers sent with every chunk request (e.g. captcha token). */
  headers?: Record<string, string>;
  onProgress: (fraction: number) => void;
  /** Optional file name; defaults to `'chunk'`. Only used for FormData. */
  filename?: string;
  /** Override sleep for testing only. */
  _sleep?: (ms: number) => Promise<void>;
}

export interface UploadResult {
  ok: boolean;
  uploadId: string | null;
  videoId: string | null;
  lastResponse: Response;
}

function defaultSleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// Sends one chunk with up to MAX_CHUNK_RETRIES retries on 5xx and network
// errors. Returns the Response (including 4xx) or a synthetic 5xx Response
// after retries are exhausted. Only throws on persistent network failures.
async function sendChunkWithRetry(
  url: string,
  fd: FormData,
  headers: Record<string, string> | undefined,
  sleep: (ms: number) => Promise<void>,
): Promise<Response> {
  let lastStatus: number | null = null;
  let lastErr: unknown;

  for (let attempt = 0; attempt <= MAX_CHUNK_RETRIES; attempt++) {
    if (attempt > 0) {
      await sleep(Math.min(RETRY_BASE_MS * Math.pow(2, attempt - 1), 8000));
    }
    try {
      const res = await fetch(url, { method: 'POST', body: fd, headers });
      if (res.status < 500) return res; // 2xx or 4xx: no retry
      // 5xx: free connection and retry
      await res.body?.cancel().catch(() => {});
      lastStatus = res.status;
    } catch (err) {
      lastErr = err;
      lastStatus = null;
    }
  }

  // Retries exhausted. Return a synthetic 5xx so the caller can inspect
  // the status and decide whether to keep stored progress.
  if (lastStatus !== null) {
    return new Response(null, { status: lastStatus });
  }
  // Persistent network error — propagate it.
  throw lastErr ?? new Error('chunk upload failed after retries');
}

// Returns a stable sessionStorage key for the given file, used to persist
// partial upload progress across page reloads.
function resumeKey(file: Blob): string {
  const name = (file as File).name ?? 'blob';
  const size = file.size;
  const mtime = (file as File).lastModified ?? 0;
  return `chunk-upload:${name}:${size}:${mtime}`;
}

type StoredProgress = { uploadId: string; nextChunk: number; chunkCount: number };
type UploadStatus =
  | { status: 'uploading'; chunkCount: number; uploadedChunks: number[] }
  | { status: 'completed'; id: string };

function loadProgress(key: string, chunkCount: number): { uploadId: string; nextChunk: number } | null {
  try {
    const raw = localStorage.getItem(key);
    if (!raw) return null;
    const stored = JSON.parse(raw) as StoredProgress;
    if (stored.chunkCount !== chunkCount || stored.nextChunk <= 0 || stored.nextChunk >= chunkCount) {
      return null;
    }
    return { uploadId: stored.uploadId, nextChunk: stored.nextChunk };
  } catch {
    return null;
  }
}

function saveProgress(key: string, uploadId: string, nextChunk: number, chunkCount: number): void {
  try {
    localStorage.setItem(key, JSON.stringify({ uploadId, nextChunk, chunkCount } satisfies StoredProgress));
  } catch { /* QuotaExceededError or SSR env — ignore */ }
}

function removeProgress(key: string): void {
  try { localStorage.removeItem(key); } catch { /* ignore */ }
}

function firstMissingChunk(chunkCount: number, uploadedChunks: number[]): number {
  const uploaded = new Set(uploadedChunks);
  for (let chunkIndex = 0; chunkIndex < chunkCount; chunkIndex++) {
    if (!uploaded.has(chunkIndex)) return chunkIndex;
  }
  return chunkCount;
}

function statusEndpoint(endpoint: string, uploadId: string): string {
  const normalized = endpoint.endsWith('/') ? endpoint.slice(0, -1) : endpoint;
  return `${normalized}/${encodeURIComponent(uploadId)}/status`;
}

async function fetchUploadStatus(
  endpoint: string,
  uploadId: string,
  headers?: Record<string, string>,
): Promise<UploadStatus | null> {
  const res = await fetch(statusEndpoint(endpoint, uploadId), { method: 'GET', headers });
  if (res.status === 404) return null;
  if (!res.ok) throw new Error(`resume status failed: ${res.status}`);
  return (await res.json()) as UploadStatus;
}

export async function uploadInChunks(opts: UploadOptions): Promise<UploadResult> {
  const { file, endpoint, target, fields, headers, onProgress, filename } = opts;
  const sleep = opts._sleep ?? defaultSleep;

  const size = file.size;
  const chunkCount = Math.max(1, Math.ceil(size / CHUNK_SIZE));
  const key = resumeKey(file);

  let uploadId: string | null = null;
  let startChunk = 0;

  // Attempt to resume a prior upload session for multi-chunk uploads.
  if (chunkCount > 1) {
    const stored = loadProgress(key, chunkCount);
    if (stored) {
      uploadId = stored.uploadId;
      startChunk = stored.nextChunk;
      if (target === 'video') {
        try {
          const status = await fetchUploadStatus(endpoint, stored.uploadId, headers);
          if (!status) {
            removeProgress(key);
            uploadId = null;
            startChunk = 0;
          } else if (status.status === 'completed') {
            removeProgress(key);
            onProgress(1);
            return {
              ok: true,
              uploadId: stored.uploadId,
              videoId: status.id,
              lastResponse: new Response(JSON.stringify({ id: status.id, status: 'queued' }), { status: 201 }),
            };
          } else if (status.chunkCount === chunkCount) {
            startChunk = firstMissingChunk(chunkCount, status.uploadedChunks);
            if (startChunk >= chunkCount) {
              startChunk = chunkCount - 1;
            }
            saveProgress(key, stored.uploadId, startChunk, chunkCount);
          } else {
            removeProgress(key);
            uploadId = null;
            startChunk = 0;
          }
        } catch {
          // Keep local progress on transient status lookup failures; the next
          // upload attempt can still resume against the existing server session.
        }
      }
      onProgress(startChunk / chunkCount);
    }
  }

  let lastResponse: Response | null = null;

  for (let i = startChunk; i < chunkCount; i++) {
    const start = i * CHUNK_SIZE;
    const end = Math.min(start + CHUNK_SIZE, size);
    const type = (file as File).type || 'application/octet-stream';
    const chunk = file.slice(start, end, type);

    const fd = new FormData();
    for (const [k, v] of Object.entries(fields ?? {})) fd.set(k, v);
    fd.set('target', target);
    fd.set('chunkIndex', String(i));
    fd.set('chunkCount', String(chunkCount));
    fd.set('fileSize', String(size));
    fd.set('file', chunk, filename ?? (file as File).name ?? 'chunk');
    if (uploadId) fd.set('uploadId', uploadId);

    const res = await sendChunkWithRetry(endpoint, fd, headers, sleep);
    lastResponse = res;

    if (!res.ok) {
      const text = await res.text().catch(() => '');
      if (res.status < 500) {
        // 4xx: user / validation error — this upload session can never succeed.
        // Clear stored progress so the next attempt starts fresh.
        removeProgress(key);
      }
      // 5xx after retries: keep stored progress so the user can retry once
      // the server recovers. The multipart session in R2/KV remains valid.
      throw new Error(`chunk ${i} failed: ${res.status} ${text}`);
    }

    if (uploadId === null) {
      try {
        const body = (await res.clone().json()) as { uploadId?: string };
        if (body.uploadId) uploadId = body.uploadId;
      } catch { /* server omits uploadId on single-chunk uploads */ }
    }

    // Persist progress after each successful chunk so a reload can resume.
    if (chunkCount > 1 && uploadId) {
      saveProgress(key, uploadId, i + 1, chunkCount);
    }

    onProgress((i + 1) / chunkCount);
  }

  if (!lastResponse) {
    throw new Error('upload finished without a server response');
  }

  // Extract videoId from the final 201 response.
  let videoId: string | null = null;
  try {
    const body = (await lastResponse.clone().json()) as { id?: string };
    if (body.id) videoId = body.id;
  } catch { /* ignore */ }

  removeProgress(key);
  return { ok: true, uploadId, videoId, lastResponse };
}
