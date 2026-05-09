import { FormEvent, useEffect, useMemo, useRef, useState } from 'react';
import { useSession } from '../lib/auth-client';
import {
  cancelUpload,
  chunkCountFor,
  clearResumeRecord,
  fetchUploadStatus,
  fingerprintFile,
  fingerprintsMatch,
  loadResumeRecord,
  saveResumeRecord,
  uploadFileInChunks,
  UploadAbortedError,
  type ResumeRecord,
} from '../lib/upload-resume';

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

type UploadStatus = 'idle' | 'uploading' | 'retrying' | 'offline' | 'paused' | 'done' | 'error';

export function Upload(): JSX.Element {
  const { data: session } = useSession();
  const [file, setFile] = useState<File | null>(null);
  const [title, setTitle] = useState('');
  const [description, setDescription] = useState('');
  const [progress, setProgress] = useState(0);
  const [error, setError] = useState<string | null>(null);
  const [status, setStatus] = useState<UploadStatus>('idle');
  const [resendStatus, setResendStatus] = useState<string | null>(null);
  const [pendingResume, setPendingResume] = useState<ResumeRecord | null>(null);
  const abortRef = useRef<AbortController | null>(null);

  const isEmailVerified = session?.user?.emailVerified !== false;
  const isValidFile = useMemo(() => {
    if (!file) {
      return false;
    }
    return file.size <= MAX_SIZE && isAcceptedVideo(file);
  }, [file]);

  // ALO-121: surface a saved resume offer on mount. The user has to re-pick
  // the same file — the File API doesn't let us hold a handle across reloads —
  // and we verify the fingerprint matches before offering resume.
  useEffect(() => {
    const stored = loadResumeRecord();
    if (stored) {
      setPendingResume(stored);
      setTitle(stored.title);
      setDescription(stored.description);
    }
  }, []);

  const canResumeWithFile = useMemo(() => {
    if (!file || !pendingResume) return false;
    return fingerprintsMatch(fingerprintFile(file), pendingResume.fingerprint);
  }, [file, pendingResume]);

  async function runUpload(resume: ResumeRecord | null): Promise<void> {
    if (!file) return;
    setError(null);
    setStatus('uploading');
    setProgress(0);

    const controller = new AbortController();
    abortRef.current = controller;

    let uploadIdForResume = resume?.uploadId ?? null;
    let skipChunks = new Set<number>();

    if (resume) {
      try {
        const remote = await fetchUploadStatus(resume.uploadId);
        if (remote && remote.chunkCount === resume.chunkCount) {
          skipChunks = new Set(remote.uploadedChunks);
        } else {
          // Server forgot the session — start fresh.
          uploadIdForResume = null;
          clearResumeRecord();
          setPendingResume(null);
        }
      } catch (err) {
        // If the status probe fails, fall back to a fresh upload rather
        // than getting stuck. The previous multipart in R2 will be cleaned
        // up by R2's lifecycle policy.
        uploadIdForResume = null;
        clearResumeRecord();
        setPendingResume(null);
        setError(err instanceof Error ? err.message : 'Could not check resume state');
      }
    }

    const chunkCount = chunkCountFor(file.size);
    const fingerprint = fingerprintFile(file);

    try {
      const result = await uploadFileInChunks(
        file,
        { title, description },
        {
          uploadId: uploadIdForResume ?? undefined,
          skipChunks,
          signal: controller.signal,
        },
        {
          onProgress: (p) => setProgress(Math.round(p.fraction * 100)),
          onStatus: (s) => setStatus(s),
          onUploadId: (uploadId) => {
            const record: ResumeRecord = {
              uploadId,
              chunkCount,
              fingerprint,
              title,
              description,
              createdAt: Date.now(),
            };
            saveResumeRecord(record);
            setPendingResume(record);
          },
        },
      );
      clearResumeRecord();
      setPendingResume(null);
      setStatus('done');
      setProgress(100);
      void result;
    } catch (err: unknown) {
      if (err instanceof UploadAbortedError) {
        setStatus('paused');
        return;
      }
      setStatus('error');
      setError(err instanceof Error ? err.message : 'Upload failed');
    } finally {
      abortRef.current = null;
    }
  }

  async function onSubmit(event: FormEvent<HTMLFormElement>): Promise<void> {
    event.preventDefault();

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

    const resume = canResumeWithFile ? pendingResume : null;
    await runUpload(resume);
  }

  async function onCancel(): Promise<void> {
    abortRef.current?.abort();
    if (pendingResume) {
      await cancelUpload(pendingResume.uploadId);
      clearResumeRecord();
      setPendingResume(null);
    }
    setStatus('idle');
    setProgress(0);
  }

  function onDiscardResume(): void {
    if (pendingResume) {
      void cancelUpload(pendingResume.uploadId);
    }
    clearResumeRecord();
    setPendingResume(null);
    setTitle('');
    setDescription('');
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

      {pendingResume ? (
        <div className="card stack-sm" data-testid="resume-banner">
          <strong>You have an unfinished upload.</strong>
          <p className="ds-meta">
            <code>{pendingResume.fingerprint.name}</code> ({Math.round(
              pendingResume.fingerprint.size / (1024 * 1024),
            )}{' '}
            MB).{' '}
            {canResumeWithFile
              ? 'Re-selecting the same file will resume where you left off.'
              : 'Pick the same file to resume, or discard to start over.'}
          </p>
          <div className="row" style={{ gap: '0.5rem' }}>
            <button type="button" className="btn btn--secondary btn--sm" onClick={onDiscardResume}>
              Discard unfinished upload
            </button>
          </div>
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
            <span className="ds-label">
              {status === 'offline'
                ? 'Waiting for connection…'
                : status === 'retrying'
                  ? 'Retrying…'
                  : status === 'paused'
                    ? 'Paused'
                    : 'Upload progress'}
            </span>
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

        <div className="row" style={{ gap: '0.5rem' }}>
          <button
            type="submit"
            className="btn"
            disabled={!isValidFile || !isEmailVerified || status === 'uploading' || status === 'retrying'}
          >
            {canResumeWithFile ? 'Resume upload' : 'Upload'}
          </button>
          {status === 'uploading' || status === 'retrying' || status === 'offline' ? (
            <button type="button" className="btn btn--secondary" onClick={() => void onCancel()}>
              Cancel
            </button>
          ) : null}
        </div>
      </form>

      {error ? <p className="status-error">{error}</p> : null}
      {status === 'done' ? <p className="status-ok">Upload complete</p> : null}
    </main>
  );
}
