// Shared chunked uploader for both /upload (file picker) and /record
// (recorder takes). The endpoint accepts multipart/form-data with one chunk
// per request and returns { uploadId } so subsequent chunks can be stitched
// server-side. Kept framework-free so it can be imported from any component.

export const CHUNK_SIZE = 10 * 1024 * 1024;

export type UploadTarget = 'video' | 'recorder';

export interface UploadOptions {
  file: Blob;
  endpoint: string;
  target: UploadTarget;
  /** Extra form fields merged into every chunk request. */
  fields?: Record<string, string>;
  onProgress: (fraction: number) => void;
  /** Optional file name; defaults to `'chunk'`. Only used for FormData. */
  filename?: string;
}

export interface UploadResult {
  ok: boolean;
  uploadId: string | null;
  lastResponse: Response;
}

export async function uploadInChunks(opts: UploadOptions): Promise<UploadResult> {
  const size = opts.file.size;
  const chunkCount = Math.max(1, Math.ceil(size / CHUNK_SIZE));
  let uploadId: string | null = null;
  let lastResponse: Response | null = null;

  for (let i = 0; i < chunkCount; i++) {
    const start = i * CHUNK_SIZE;
    const end = Math.min(start + CHUNK_SIZE, size);
    const type = (opts.file as File).type || 'application/octet-stream';
    const chunk = opts.file.slice(start, end, type);

    const fd = new FormData();
    for (const [k, v] of Object.entries(opts.fields ?? {})) fd.set(k, v);
    fd.set('target', opts.target);
    fd.set('chunkIndex', String(i));
    fd.set('chunkCount', String(chunkCount));
    fd.set('file', chunk, opts.filename ?? (opts.file as File).name ?? 'chunk');
    if (uploadId) fd.set('uploadId', uploadId);

    const res = await fetch(opts.endpoint, { method: 'POST', body: fd });
    lastResponse = res;
    if (!res.ok) {
      const text = await res.text().catch(() => '');
      throw new Error(`chunk ${i} failed: ${res.status} ${text}`);
    }
    if (uploadId === null) {
      try {
        const body = (await res.clone().json()) as { uploadId?: string };
        if (body.uploadId) uploadId = body.uploadId;
      } catch { /* server can omit uploadId on single-chunk uploads */ }
    }
    opts.onProgress((i + 1) / chunkCount);
  }

  return { ok: true, uploadId, lastResponse: lastResponse! };
}
