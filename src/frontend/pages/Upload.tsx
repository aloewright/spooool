import { FormEvent, useMemo, useState } from 'react';
import { useSession } from '../lib/auth-client';

const CHUNK_SIZE = 10 * 1024 * 1024;
const MAX_SIZE = 30 * 1024 * 1024 * 1024;
const ALLOWED_EXTENSIONS = new Set([
  'mp4',
  'm4v',
  'webm',
  'mov',
  'mkv',
  'avi',
  'mpeg',
  'mpg',
  'ogv',
  '3gp',
  'flv',
  'ts',
]);

function isAcceptedVideo(file: File): boolean {
  if (file.type && file.type.startsWith('video/')) return true;
  const dot = file.name.lastIndexOf('.');
  if (dot < 0) return false;
  return ALLOWED_EXTENSIONS.has(file.name.slice(dot + 1).toLowerCase());
}

function resumeKey(file: File): string {
  return `spooool:upload:${file.name}:${file.size}:${file.lastModified}`;
}

async function fetchResumeState(
  uploadId: string,
): Promise<{ received: number[]; chunkCount: number } | null> {
  try {
    const res = await fetch(`/api/videos/upload/${encodeURIComponent(uploadId)}/status`, {
      credentials: 'same-origin',
    });
    if (!res.ok) return null;
    const data = (await res.json()) as { received?: number[]; chunkCount?: number };
    if (typeof data.chunkCount !== 'number' || !Array.isArray(data.received)) return null;
    return { received: data.received, chunkCount: data.chunkCount };
  } catch {
    return null;
  }
}

async function uploadInChunks(
  file: File,
  title: string,
  description: string,
  onProgress: (value: number) => void,
): Promise<Response> {
  const chunkCount = Math.ceil(file.size / CHUNK_SIZE);
  let lastResponse: Response | null = null;
  let uploadId: string | null = null;
  const received = new Set<number>();

  // ALO-121: resume across page reloads / disconnects. Persist uploadId
  // keyed by file identity so a refresh continues where the last attempt
  // left off; the server is the source of truth for which chunks landed.
  const persistKey = resumeKey(file);
  const stored = typeof localStorage !== 'undefined' ? localStorage.getItem(persistKey) : null;
  if (stored) {
    const state = await fetchResumeState(stored);
    if (state && state.chunkCount === chunkCount) {
      uploadId = stored;
      for (const i of state.received) received.add(i);
      if (received.size > 0) {
        onProgress(Math.round((received.size / chunkCount) * 100));
      }
    } else {
      try { localStorage.removeItem(persistKey); } catch { /* private mode */ }
    }
  }

  for (let index = 0; index < chunkCount; index += 1) {
    if (received.has(index) && index < chunkCount - 1) {
      // Final chunk must still be sent so the server can run completion;
      // intermediate chunks the server already has can be skipped.
      onProgress(Math.round(((index + 1) / chunkCount) * 100));
      continue;
    }
    const start = index * CHUNK_SIZE;
    const end = Math.min(start + CHUNK_SIZE, file.size);
    const chunk = file.slice(start, end, file.type);

    let attempt = 0;
    const maxAttempts = 4;
    // Per-chunk retry with exponential backoff. Network blips and 5xx are
    // transient; the server is idempotent on chunk re-submission so retries
    // are safe.
    while (true) {
      const formData = new FormData();
      formData.set('title', title);
      formData.set('description', description);
      formData.set('file', chunk, file.name);
      formData.set('chunkIndex', String(index));
      formData.set('chunkCount', String(chunkCount));
      if (uploadId) formData.set('uploadId', uploadId);

      let res: Response;
      try {
        res = await fetch('/api/videos/upload', { method: 'POST', body: formData });
      } catch (err) {
        if (++attempt >= maxAttempts) throw err;
        await new Promise((r) => setTimeout(r, 500 * 2 ** (attempt - 1)));
        continue;
      }

      if (res.ok) {
        lastResponse = res;
        const responseData = (await res.json()) as { uploadId?: string };
        if (responseData.uploadId) {
          uploadId = responseData.uploadId;
          try { localStorage.setItem(persistKey, uploadId); } catch { /* private mode */ }
        }
        received.add(index);
        break;
      }

      if (res.status >= 500 && ++attempt < maxAttempts) {
        await new Promise((r) => setTimeout(r, 500 * 2 ** (attempt - 1)));
        continue;
      }

      const body = await res.text();
      let detail = body;
      try {
        const parsed = JSON.parse(body) as { error?: string; code?: string };
        detail = parsed.error ?? body;
        if (parsed.code) detail = `${detail} (${parsed.code})`;
      } catch {
        /* non-JSON */
      }
      throw new Error(`Upload failed (${res.status}): ${detail.slice(0, 300)}`);
    }

    onProgress(Math.round(((index + 1) / chunkCount) * 100));
  }

  try { localStorage.removeItem(persistKey); } catch { /* private mode */ }

  if (!lastResponse) {
    throw new Error('No upload response');
  }
  return lastResponse;
}

async function resendVerification(): Promise<{ ok: boolean; error: string | null }> {
  // ALO-128: ask better-auth to re-issue the verification email. The session
  // cookie identifies the user, so the body is empty.
  let res: Response;
  try {
    res = await fetch('/api/auth/send-verification-email', {
      method: 'POST',
      credentials: 'same-origin',
      headers: { 'content-type': 'application/json' },
      body: '{}',
    });
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : 'Network error' };
  }
  if (res.ok) return { ok: true, error: null };
  let message = `Request failed (${res.status})`;
  try {
    const body = (await res.json()) as { message?: string; error?: string } | null;
    message = body?.message ?? body?.error ?? message;
  } catch {
    // body wasn't JSON
  }
  return { ok: false, error: message };
}

export function Upload(): JSX.Element {
  const { data: session } = useSession();
  const [file, setFile] = useState<File | null>(null);
  const [title, setTitle] = useState('');
  const [description, setDescription] = useState('');
  const [progress, setProgress] = useState(0);
  const [error, setError] = useState<string | null>(null);
  const [status, setStatus] = useState<string | null>(null);
  const [resendStatus, setResendStatus] = useState<string | null>(null);

  const isEmailVerified = session?.user?.emailVerified !== false;
  const isValidFile = useMemo(() => {
    if (!file) {
      return false;
    }
    return file.size <= MAX_SIZE && isAcceptedVideo(file);
  }, [file]);

  async function onSubmit(event: FormEvent<HTMLFormElement>): Promise<void> {
    event.preventDefault();
    setError(null);
    setStatus(null);

    if (!file) {
      setError('Please choose a file');
      return;
    }
    if (!isAcceptedVideo(file)) {
      setError('Unsupported file type');
      return;
    }
    if (file.size > MAX_SIZE) {
      setError('File exceeds 30GB max size');
      return;
    }

    try {
      await uploadInChunks(file, title, description, setProgress);
      setStatus('Upload complete');
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : 'Upload failed');
    }
  }

  return (
    <main className="app-main app-main--narrow stack-lg fade-in">
      <div className="stack-sm">
        <span className="ds-label">Upload</span>
        <h1 className="ds-h2">Add a video</h1>
      </div>

      {!isEmailVerified ? (
        <div className="card stack-sm" data-testid="verify-banner">
          <strong>Verify your email to upload.</strong>
          <p className="ds-meta">
            We sent a verification link to {session?.user?.email ?? 'your email'}. Click the
            link, then refresh this page.
          </p>
          <div>
            <button
              type="button"
              className="btn btn--secondary btn--sm"
              onClick={() => {
                void resendVerification().then((r) =>
                  setResendStatus(r.ok ? 'Verification email sent.' : r.error ?? 'Failed'),
                );
              }}
            >
              Resend verification email
            </button>
          </div>
          {resendStatus ? <p className="ds-meta">{resendStatus}</p> : null}
        </div>
      ) : null}

      <form
        onSubmit={(event) => void onSubmit(event)}
        className="card stack"
      >
        <div className="field">
          <label className="field__label" htmlFor="upload-title">
            Title
          </label>
          <input
            id="upload-title"
            className="input"
            value={title}
            onChange={(event) => setTitle(event.target.value)}
            required
          />
        </div>

        <div className="field">
          <label className="field__label" htmlFor="upload-description">
            Description
          </label>
          <textarea
            id="upload-description"
            className="input"
            value={description}
            onChange={(event) => setDescription(event.target.value)}
          />
        </div>

        <div className="field">
          <label className="field__label" htmlFor="upload-file">
            Video file
          </label>
          <input
            id="upload-file"
            type="file"
            className="input"
            accept="video/*"
            onChange={(event) => setFile(event.target.files?.[0] ?? null)}
            required
          />
          <span className="ds-meta">MP4, MOV, MKV, WebM, AVI, MPEG, M4V, 3GP, FLV, OGV, or TS. 30GB max.</span>
        </div>

        <div className="stack-sm">
          <div className="row" style={{ justifyContent: 'space-between' }}>
            <span className="ds-label">Upload progress</span>
            <span className="ds-meta">{progress}%</span>
          </div>
          <div
            className="meter"
            role="progressbar"
            aria-valuenow={progress}
            aria-valuemin={0}
            aria-valuemax={100}
          >
            <div className="meter__bar" style={{ width: `${progress}%` }} />
          </div>
        </div>

        <div>
          <button type="submit" className="btn" disabled={!isValidFile || !isEmailVerified}>
            Upload
          </button>
        </div>
      </form>

      {error ? <p className="status-error">{error}</p> : null}
      {status ? <p className="status-ok">{status}</p> : null}
    </main>
  );
}
