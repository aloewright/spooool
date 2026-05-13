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

async function uploadInChunks(
  file: File,
  title: string,
  description: string,
  onProgress: (value: number) => void,
): Promise<Response> {
  const chunkCount = Math.ceil(file.size / CHUNK_SIZE);
  let lastResponse: Response | null = null;
  let uploadId: string | null = null;

  for (let index = 0; index < chunkCount; index += 1) {
    const start = index * CHUNK_SIZE;
    const end = Math.min(start + CHUNK_SIZE, file.size);
    // Pass file.type so the resulting Blob keeps the parent's MIME — without it
    // the chunk's type is '' and the multipart part is sent as
    // application/octet-stream, which the upload validator then rejects.
    const chunk = file.slice(start, end, file.type);
    const formData = new FormData();
    formData.set('title', title);
    formData.set('description', description);
    formData.set('file', chunk, file.name);
    formData.set('chunkIndex', String(index));
    formData.set('chunkCount', String(chunkCount));
    if (uploadId) {
      formData.set('uploadId', uploadId);
    }

    lastResponse = await fetch('/api/videos/upload', {
      method: 'POST',
      body: formData,
    });

    if (!lastResponse.ok) {
      const body = await lastResponse.text();
      let detail = body;
      try {
        const parsed = JSON.parse(body) as { error?: string; code?: string };
        detail = parsed.error ?? body;
        if (parsed.code) detail = `${detail} (${parsed.code})`;
      } catch {
        // Non-JSON response — keep raw text.
      }
      throw new Error(`Upload failed (${lastResponse.status}): ${detail.slice(0, 300)}`);
    }

    const responseData = (await lastResponse.json()) as { uploadId?: string };
    if (responseData.uploadId) {
      uploadId = responseData.uploadId;
    }

    onProgress(Math.round(((index + 1) / chunkCount) * 100));
  }

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

    // ALO-184: PostHog funnel event so we can chart Upload start → complete.
    // File size is bucketed in MB to avoid surfacing odd byte values in the
    // event explorer; never includes title/description (PII risk).
    const sizeMb = Math.round(file.size / (1024 * 1024));
    void import('../lib/analytics').then(({ track }) =>
      track('upload_started', { size_mb: sizeMb, chunk_count: Math.ceil(file.size / CHUNK_SIZE) }),
    );

    try {
      await uploadInChunks(file, title, description, setProgress);
      setStatus('Upload complete');
      void import('../lib/analytics').then(({ track }) =>
        track('upload_completed', { size_mb: sizeMb }),
      );
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : 'Upload failed';
      setError(message);
      void import('../lib/analytics').then(({ track }) =>
        track('upload_failed', { size_mb: sizeMb, reason: message.slice(0, 200) }),
      );
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
