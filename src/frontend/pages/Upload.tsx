import { FormEvent, useMemo, useState } from 'react';
import { useSession } from '../lib/auth-client';
import { uploadInChunks as runChunkedUpload, CHUNK_SIZE } from '../lib/chunked-upload';
import { TurnstileWidget } from '../components/TurnstileWidget';
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
  captchaToken?: string | null,
): Promise<Response> {
  const result = await runChunkedUpload({
    file,
    endpoint: '/api/videos/upload',
    target: 'video',
    fields: { title, description },
    headers: captchaToken ? { 'x-captcha-response': captchaToken } : undefined,
    onProgress: (fraction) => onProgress(Math.round(fraction * 100)),
  });
  return result.lastResponse;
}

// Maps the chunk-upload error message back to a low-cardinality bucket so
// analytics never receives raw server text. uploadInChunks throws messages
// of the form "chunk N failed: <status> <body>" — we key on the status.
export function classifyUploadError(message: string): string {
  const match = /chunk \d+ failed: (\d{3})/.exec(message);
  if (!match) return 'network_error';
  const status = Number(match[1]);
  if (status === 413) return 'http_413';
  if (status === 429) return 'http_429';
  if (status >= 400 && status < 500) return 'http_4xx';
  if (status >= 500) return 'http_5xx';
  return 'unknown';
}

async function resendVerification(email: string): Promise<{ ok: boolean; error: string | null }> {
  // ALO-128: ask better-auth to re-issue the verification email. better-auth
  // requires the email in the body and cross-checks it against the session.
  let res: Response;
  try {
    res = await fetch('/api/auth/send-verification-email', {
      method: 'POST',
      credentials: 'same-origin',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ email }),
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
  const [captchaToken, setCaptchaToken] = useState<string | null>(null);
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

    if (import.meta.env.VITE_TURNSTILE_SITE_KEY && !captchaToken) {
      setError('Please complete the captcha');
      return;
    }

    // ALO-184: PostHog funnel event so we can chart Upload start → complete.
    // File size is bucketed in MB to avoid surfacing odd byte values in the
    // event explorer; never includes title/description (PII risk).
    const sizeMb = Math.round(file.size / (1024 * 1024));
    // Import once and reuse so we don't dispatch three speculative chunk
    // fetches on every submit. Module loader caches the promise but the
    // intent reads more clearly when we capture it.
    const analyticsPromise = import('../lib/analytics').catch(() => null);
    const dispatch = (event: string, props: Record<string, unknown>): void => {
      void analyticsPromise.then((mod) => mod?.track(event, props));
    };
    dispatch('upload_started', {
      size_mb: sizeMb,
      chunk_count: Math.ceil(file.size / CHUNK_SIZE),
    });

    try {
      await uploadInChunks(file, title, description, setProgress, captchaToken);
      setStatus('Upload complete');
      dispatch('upload_completed', { size_mb: sizeMb });
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : 'Upload failed';
      setError(message);
      // Bucket into a small enum so analytics never receives raw server text
      // (which could embed paths, emails, or other internal detail).
      dispatch('upload_failed', { size_mb: sizeMb, reason: classifyUploadError(message) });
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
                const email = session?.user?.email;
                if (!email) {
                  setResendStatus('No email on session.');
                  return;
                }
                void resendVerification(email).then((r) =>
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

        <TurnstileWidget onSuccess={(token) => setCaptchaToken(token)} />

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
