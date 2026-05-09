// ALO-121: chunked upload with retry + resume.
//
// The backend stores per-upload state in KV under uploadId for 24h. This
// module is responsible for:
//
//   - Slicing the file into 10MB chunks (matching MAX_CHUNK_BYTES on the
//     server's upload-validation).
//   - Retrying each chunk POST with exponential backoff on transient
//     failures (5xx, 408, 429, network errors). 4xx with a deterministic
//     payload (e.g. validation failure) aborts immediately.
//   - Pausing while the browser is offline and resuming when 'online' fires.
//   - Persisting `{ uploadId, chunkCount, fingerprint }` to localStorage so
//     a page reload after a disconnect can rejoin the same upload by
//     calling GET /api/videos/upload/:uploadId/status and skipping
//     already-uploaded chunks.
//
// The server expects `chunkIndex=0` to come first when no `uploadId` is
// supplied, but accepts an explicit `uploadId` for retry. The resumption
// path skips chunk-0 if it's already on the server, so we never need to
// re-init the multipart from the client side.

export const CHUNK_SIZE = 10 * 1024 * 1024;
export const MAX_VIDEO_BYTES = 30 * 1024 * 1024 * 1024;
const RESUME_STORAGE_KEY = 'spooool.upload.resume.v1';
const DEFAULT_MAX_RETRIES = 4;
const BASE_BACKOFF_MS = 500;
const MAX_BACKOFF_MS = 15_000;

export interface FileFingerprint {
  name: string;
  size: number;
  lastModified: number;
}

export interface ResumeRecord {
  uploadId: string;
  chunkCount: number;
  fingerprint: FileFingerprint;
  title: string;
  description: string;
  // Wall-clock time the record was written. Used to expire local records
  // older than the server's 24h KV TTL (see UPLOAD_SESSION_TTL_SECONDS).
  createdAt: number;
}

export const RESUME_RECORD_TTL_MS = 23 * 60 * 60 * 1000;

export function fingerprintFile(file: File): FileFingerprint {
  return {
    name: file.name,
    size: file.size,
    lastModified: file.lastModified,
  };
}

export function fingerprintsMatch(a: FileFingerprint, b: FileFingerprint): boolean {
  return a.name === b.name && a.size === b.size && a.lastModified === b.lastModified;
}

export function chunkCountFor(fileSize: number, chunkSize: number = CHUNK_SIZE): number {
  if (fileSize <= 0) return 1;
  return Math.ceil(fileSize / chunkSize);
}

export function loadResumeRecord(
  storage: Pick<Storage, 'getItem'> | null = typeof localStorage === 'undefined'
    ? null
    : localStorage,
  now: number = Date.now(),
): ResumeRecord | null {
  if (!storage) return null;
  const raw = storage.getItem(RESUME_STORAGE_KEY);
  if (!raw) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return null;
  }
  if (!isResumeRecord(parsed)) return null;
  if (now - parsed.createdAt > RESUME_RECORD_TTL_MS) return null;
  return parsed;
}

export function saveResumeRecord(
  record: ResumeRecord,
  storage: Pick<Storage, 'setItem'> | null = typeof localStorage === 'undefined'
    ? null
    : localStorage,
): void {
  if (!storage) return;
  try {
    storage.setItem(RESUME_STORAGE_KEY, JSON.stringify(record));
  } catch {
    // Quota exceeded / private mode — non-fatal; resume just won't survive a reload.
  }
}

export function clearResumeRecord(
  storage: Pick<Storage, 'removeItem'> | null = typeof localStorage === 'undefined'
    ? null
    : localStorage,
): void {
  if (!storage) return;
  try {
    storage.removeItem(RESUME_STORAGE_KEY);
  } catch {
    // Same rationale as saveResumeRecord — best-effort.
  }
}

function isResumeRecord(v: unknown): v is ResumeRecord {
  if (!v || typeof v !== 'object') return false;
  const r = v as Record<string, unknown>;
  if (typeof r.uploadId !== 'string') return false;
  if (typeof r.chunkCount !== 'number' || r.chunkCount < 1) return false;
  if (typeof r.title !== 'string') return false;
  if (typeof r.description !== 'string') return false;
  if (typeof r.createdAt !== 'number') return false;
  const fp = r.fingerprint as Record<string, unknown> | undefined;
  if (!fp || typeof fp !== 'object') return false;
  return (
    typeof fp.name === 'string' &&
    typeof fp.size === 'number' &&
    typeof fp.lastModified === 'number'
  );
}

export interface UploadStatusResponse {
  uploadId: string;
  chunkCount: number;
  uploadedChunks: number[];
  fileName: string | null;
  fileSize: number | null;
  title: string;
  description: string;
}

export type RetryClassification = 'retry' | 'fail';

// Pure, testable: decide if a chunk POST should be retried or abandoned.
// 5xx, 408 Request Timeout, 429 Too Many Requests are transient.
// 0 (network error: client-side fetch threw) is also transient.
export function classifyChunkResponse(status: number): RetryClassification {
  if (status === 0) return 'retry';
  if (status === 408 || status === 429) return 'retry';
  if (status >= 500 && status < 600) return 'retry';
  return 'fail';
}

export function backoffMs(
  attempt: number,
  base: number = BASE_BACKOFF_MS,
  max: number = MAX_BACKOFF_MS,
): number {
  // Exponential, capped, with full jitter so a thundering herd of failed
  // chunks doesn't all retry on the same tick.
  const exp = Math.min(max, base * 2 ** attempt);
  return Math.floor(Math.random() * exp);
}

export interface UploadProgress {
  /** Fraction in [0, 1]. */
  fraction: number;
  /** 0-indexed chunk count completed (across resume + new). */
  completed: number;
  total: number;
}

export interface UploadCallbacks {
  onProgress?: (progress: UploadProgress) => void;
  /** Fired after chunk-0 succeeds with an uploadId so the caller can persist a resume record. */
  onUploadId?: (uploadId: string) => void;
  /** Fired when the uploader transitions between online/offline / retrying. */
  onStatus?: (status: 'uploading' | 'retrying' | 'offline' | 'paused') => void;
}

export interface UploadOptions {
  fetchImpl?: typeof fetch;
  signal?: AbortSignal;
  maxRetries?: number;
  /** Override for tests so backoff doesn't actually delay. */
  delay?: (ms: number) => Promise<void>;
  /** True when window.navigator.onLine is false. Falls back to true. */
  isOffline?: () => boolean;
  /** Resolves when the network is back. In production this is a 'online' event subscription. */
  waitForOnline?: () => Promise<void>;
  /** Pre-existing uploadId to resume against. */
  uploadId?: string;
  /** Indices that the server has already received — these chunks are skipped. */
  skipChunks?: ReadonlySet<number>;
  /** Override chunk size for tests. */
  chunkSize?: number;
}

export interface UploadResult {
  videoId: string;
  status: string;
}

export class UploadAbortedError extends Error {
  constructor() {
    super('Upload aborted');
    this.name = 'UploadAbortedError';
  }
}

async function defaultDelay(ms: number): Promise<void> {
  if (ms <= 0) return;
  await new Promise((resolve) => setTimeout(resolve, ms));
}

function defaultIsOffline(): boolean {
  return typeof navigator !== 'undefined' && navigator.onLine === false;
}

function defaultWaitForOnline(): Promise<void> {
  if (typeof window === 'undefined') return Promise.resolve();
  if (navigator.onLine) return Promise.resolve();
  return new Promise<void>((resolve) => {
    const handler = (): void => {
      window.removeEventListener('online', handler);
      resolve();
    };
    window.addEventListener('online', handler, { once: true });
  });
}

interface ChunkAttemptOutcome {
  ok: true;
  status: number;
  body: { uploadId?: string; id?: string; status?: string };
}

interface ChunkAttemptFailure {
  ok: false;
  status: number;
  errorMessage: string;
  retryable: boolean;
}

async function postChunkOnce(
  url: string,
  formData: FormData,
  fetchImpl: typeof fetch,
  signal: AbortSignal | undefined,
): Promise<ChunkAttemptOutcome | ChunkAttemptFailure> {
  let res: Response;
  try {
    res = await fetchImpl(url, { method: 'POST', body: formData, signal });
  } catch (err) {
    if ((err as { name?: string }).name === 'AbortError') {
      throw new UploadAbortedError();
    }
    return {
      ok: false,
      status: 0,
      errorMessage: err instanceof Error ? err.message : 'Network error',
      retryable: true,
    };
  }
  const text = await res.text();
  let parsed: { uploadId?: string; id?: string; status?: string; error?: string; code?: string } = {};
  try {
    parsed = text ? JSON.parse(text) : {};
  } catch {
    parsed = {};
  }
  if (!res.ok) {
    const errorMessage =
      (parsed.error ? `${parsed.error}${parsed.code ? ` (${parsed.code})` : ''}` : text)
      || `HTTP ${res.status}`;
    return {
      ok: false,
      status: res.status,
      errorMessage,
      retryable: classifyChunkResponse(res.status) === 'retry',
    };
  }
  return { ok: true, status: res.status, body: parsed };
}

// Sliceable so tests can substitute a synthetic blob source.
export interface FileSlice {
  size: number;
  type: string;
  name: string;
  slice(start: number, end: number, contentType?: string): Blob;
}

export async function uploadFileInChunks(
  file: FileSlice,
  metadata: { title: string; description: string },
  options: UploadOptions = {},
  callbacks: UploadCallbacks = {},
): Promise<UploadResult> {
  const fetchImpl = options.fetchImpl ?? fetch;
  const delay = options.delay ?? defaultDelay;
  const isOffline = options.isOffline ?? defaultIsOffline;
  const waitForOnline = options.waitForOnline ?? defaultWaitForOnline;
  const maxRetries = options.maxRetries ?? DEFAULT_MAX_RETRIES;
  const chunkSize = options.chunkSize ?? CHUNK_SIZE;
  const chunkCount = chunkCountFor(file.size, chunkSize);
  const skip = options.skipChunks ?? new Set<number>();

  let uploadId: string | null = options.uploadId ?? null;
  let lastBody: { uploadId?: string; id?: string; status?: string } | null = null;
  let completed = skip.size;

  const emitProgress = (): void => {
    callbacks.onProgress?.({
      fraction: chunkCount === 0 ? 1 : completed / chunkCount,
      completed,
      total: chunkCount,
    });
  };

  // Emit initial progress so the UI reflects already-uploaded chunks
  // immediately on resume.
  emitProgress();

  for (let index = 0; index < chunkCount; index += 1) {
    if (options.signal?.aborted) throw new UploadAbortedError();
    if (skip.has(index)) continue;

    const start = index * chunkSize;
    const end = Math.min(start + chunkSize, file.size);
    const chunk = file.slice(start, end, file.type);

    let attempt = 0;
    let backoff = 0;
    while (true) {
      if (options.signal?.aborted) throw new UploadAbortedError();
      if (isOffline()) {
        callbacks.onStatus?.('offline');
        await waitForOnline();
      }
      callbacks.onStatus?.(attempt === 0 ? 'uploading' : 'retrying');

      const formData = new FormData();
      formData.set('title', metadata.title);
      formData.set('description', metadata.description);
      formData.set('file', chunk, file.name);
      formData.set('chunkIndex', String(index));
      formData.set('chunkCount', String(chunkCount));
      if (uploadId) formData.set('uploadId', uploadId);

      const outcome = await postChunkOnce('/api/videos/upload', formData, fetchImpl, options.signal);
      if (outcome.ok) {
        lastBody = outcome.body;
        if (!uploadId && outcome.body.uploadId) {
          uploadId = outcome.body.uploadId;
          callbacks.onUploadId?.(uploadId);
        }
        break;
      }
      if (!outcome.retryable || attempt >= maxRetries) {
        throw new Error(`Upload failed (${outcome.status}): ${outcome.errorMessage}`);
      }
      backoff = backoffMs(attempt);
      attempt += 1;
      callbacks.onStatus?.('retrying');
      await delay(backoff);
    }

    completed += 1;
    emitProgress();
  }

  if (!lastBody) {
    // Edge case: every chunk was skipped (already uploaded) but the server
    // still owes us a completion. The backend completes the multipart on
    // the final chunk's POST, so if every chunk was already on the server
    // the multipart is already complete and the videoId is in the resume
    // status response — but we don't carry that here. The caller is
    // expected to have driven the final chunk through this function.
    throw new Error('Upload finished without a completion response');
  }
  return {
    videoId: lastBody.id ?? '',
    status: lastBody.status ?? 'queued',
  };
}

// Calls GET /api/videos/upload/:uploadId/status. Returns null on 404 so the
// caller can transparently fall through to a fresh upload when the server's
// session has expired.
export async function fetchUploadStatus(
  uploadId: string,
  fetchImpl: typeof fetch = fetch,
): Promise<UploadStatusResponse | null> {
  const res = await fetchImpl(
    `/api/videos/upload/${encodeURIComponent(uploadId)}/status`,
    { method: 'GET' },
  );
  if (res.status === 404) return null;
  if (!res.ok) {
    throw new Error(`Resume status failed (${res.status})`);
  }
  return (await res.json()) as UploadStatusResponse;
}

// Best-effort. The DELETE endpoint is idempotent, so a swallowed network
// error here at most leaves the multipart sitting in R2 until R2's lifecycle
// rules clean it up.
export async function cancelUpload(
  uploadId: string,
  fetchImpl: typeof fetch = fetch,
): Promise<void> {
  try {
    await fetchImpl(`/api/videos/upload/${encodeURIComponent(uploadId)}`, {
      method: 'DELETE',
    });
  } catch {
    // Network error mid-cancel: best-effort.
  }
}
