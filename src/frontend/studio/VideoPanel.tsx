// VideoPanel — generative video b-roll panel (ALO-647).
// Submits a prompt to POST /api/studio/video (AI_GEN queue → Veo 3.1) and
// polls GET /api/studio/assets/:id until ready or failed.

import { FormEvent, useEffect, useRef, useState } from 'react';
import { Link } from 'react-router-dom';
import {
  ApiError,
  postVideoGen,
  getGeneratedAsset,
  type GeneratedAssetStatus,
} from './lib/studio-client';
import { Spinner } from '../create/Spinner';

const POLL_INTERVAL_MS = 5_000;

export function VideoPanel(): JSX.Element {
  const [prompt, setPrompt] = useState('');
  const [busy, setBusy] = useState(false);
  const [assetId, setAssetId] = useState<string | null>(null);
  const [asset, setAsset] = useState<GeneratedAssetStatus | null>(null);
  const [error, setError] = useState<ApiError | Error | null>(null);
  const pollRef = useRef<ReturnType<typeof setInterval> | null>(null);

  useEffect(() => () => {
    if (pollRef.current) clearInterval(pollRef.current);
  }, []);

  function stopPolling(): void {
    if (pollRef.current) {
      clearInterval(pollRef.current);
      pollRef.current = null;
    }
  }

  function startPolling(id: string): void {
    stopPolling();
    const tick = (): void => {
      void (async () => {
        try {
          const status = await getGeneratedAsset(id);
          setAsset(status);
          if (status.status === 'ready' || status.status === 'failed') {
            stopPolling();
            setBusy(false);
          }
        } catch (err) {
          setError(err instanceof Error ? err : new Error(String(err)));
          stopPolling();
          setBusy(false);
        }
      })();
    };
    tick();
    pollRef.current = setInterval(tick, POLL_INTERVAL_MS);
  }

  async function onSubmit(e: FormEvent<HTMLFormElement>): Promise<void> {
    e.preventDefault();
    const p = prompt.trim();
    if (!p || busy) return;
    setError(null);
    setBusy(true);
    setAssetId(null);
    setAsset(null);
    stopPolling();
    try {
      const queued = await postVideoGen(p);
      setAssetId(queued.assetId);
      setAsset({ id: queued.assetId, kind: 'video', status: 'queued', stream_video_id: null, r2_key: null, error_message: null });
      startPolling(queued.assetId);
    } catch (err) {
      setError(err instanceof Error ? err : new Error(String(err)));
      setBusy(false);
    }
  }

  const isGenerating = busy && asset && (asset.status === 'queued' || asset.status === 'processing');
  const isReady = asset?.status === 'ready';
  const isFailed = asset?.status === 'failed' && !error;

  return (
    <form onSubmit={(e) => void onSubmit(e)} className="card stack">
      <label className="field">
        <span className="field__label">Generate a video clip (b-roll)</span>
        <textarea
          className="input"
          rows={3}
          value={prompt}
          onChange={(e) => setPrompt(e.target.value)}
          maxLength={2048}
          placeholder="e.g., aerial shot of ocean waves, golden hour, slow motion"
          disabled={busy}
        />
      </label>

      {isGenerating ? (
        <p aria-live="polite" className="ds-lede">
          <Spinner size={16} inline label="Generating video…" />
          {asset?.status === 'processing' ? ' Processing…' : ' Queued — this may take a few minutes.'}
        </p>
      ) : null}

      {isReady && asset ? (
        <div className="stack">
          {asset.stream_video_id ? (
            <p>
              <Link to={`/watch/${asset.stream_video_id}`}>Watch your generated video</Link>
            </p>
          ) : (
            <p className="ds-meta">Video ready — check <Link to="/profile">My Videos</Link>.</p>
          )}
        </div>
      ) : null}

      {isFailed ? (
        <div className="alert alert--error" role="alert">
          <strong>Video generation failed.</strong>
          {asset?.error_message ? (
            <p style={{ marginTop: 4 }}>{asset.error_message}</p>
          ) : null}
        </div>
      ) : null}

      {error ? (
        <div className="alert alert--error" role="alert">
          <strong>Couldn&apos;t generate video.</strong>
          <p style={{ marginTop: 4 }}>{error.message}</p>
          {error instanceof ApiError && error.status === 429 ? (
            <p style={{ marginTop: 4, fontSize: 'var(--text-sm)' }}>
              Rate limit: 30 studio generations per hour.
            </p>
          ) : null}
          {error instanceof ApiError && error.status === 503 ? (
            <p style={{ marginTop: 4, fontSize: 'var(--text-sm)' }}>
              Video generation is temporarily unavailable. Try again later.
            </p>
          ) : null}
        </div>
      ) : null}

      <button type="submit" className="btn btn--primary" disabled={!prompt.trim() || busy}>
        {busy ? <Spinner size={16} inline label="Generating…" /> : 'Generate video clip'}
      </button>
    </form>
  );
}
