import { FormEvent, useEffect, useRef, useState, type JSX } from 'react';
import { Link } from '@tanstack/react-router';
import {
  ApiError,
  getRenderJob,
  postAnimation,
  type AnimationRequestBody,
  type RenderJobStatus,
} from './lib/studio-client';
import { Spinner } from '../create/Spinner';

type Stage = 'idle' | 'planning' | 'asset_generation' | 'voiceover' | 'rendering' | 'encoding' | 'ready';

const STAGE_LABELS: Record<Stage, string> = {
  idle: '',
  planning: 'Planning animation…',
  asset_generation: 'Generating assets…',
  voiceover: 'Synthesizing voiceover…',
  rendering: 'Rendering video…',
  encoding: 'Encoding video…',
  ready: 'Ready',
};

export function AnimationPanel(): JSX.Element {
  const [prompt, setPrompt] = useState('');
  const [aspectRatio, setAspectRatio] = useState<AnimationRequestBody['aspectRatio']>('16:9');
  const [durationSeconds, setDurationSeconds] = useState<AnimationRequestBody['durationSeconds']>(30);
  const [style, setStyle] = useState<AnimationRequestBody['style']>('clean');
  const [voiceover, setVoiceover] = useState<AnimationRequestBody['voiceover']>('none');
  const [useGeneratedImages, setUseGeneratedImages] = useState(false);
  const [busy, setBusy] = useState(false);
  const [stage, setStage] = useState<Stage>('idle');
  const [jobId, setJobId] = useState<string | null>(null);
  const [renderStatus, setRenderStatus] = useState<RenderJobStatus | null>(null);
  const [estimateUsd, setEstimateUsd] = useState<number | null>(null);
  const [generatedAssetCount, setGeneratedAssetCount] = useState<number | null>(null);
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
          const status = await getRenderJob(id);
          setRenderStatus(status);
          if (status.status === 'rendering') setStage('rendering');
          if (status.status === 'completed') {
            setStage(status.videoId ? 'ready' : 'encoding');
            if (status.videoId) {
              setStage('ready');
              stopPolling();
              setBusy(false);
            }
          }
          if (status.status === 'failed') {
            setError(new Error(status.error ?? 'Render failed'));
            setStage('idle');
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
    pollRef.current = setInterval(tick, 2000);
  }

  async function onSubmit(e: FormEvent<HTMLFormElement>): Promise<void> {
    e.preventDefault();
    const p = prompt.trim();
    if (!p || busy) return;
    setError(null);
    setBusy(true);
    setStage('planning');
    setJobId(null);
    setRenderStatus(null);
    setEstimateUsd(null);
    setGeneratedAssetCount(null);
    stopPolling();

    try {
      if (useGeneratedImages) setStage('asset_generation');
      if (voiceover !== 'none') setStage('voiceover');

      const queued = await postAnimation({
        prompt: p,
        aspectRatio,
        durationSeconds,
        style,
        voiceover,
        useGeneratedImages,
      });
      setJobId(queued.jobId);
      setEstimateUsd(queued.estimate.estimatedCostUsd);
      setGeneratedAssetCount(queued.generatedAssetCount);
      setStage('rendering');
      startPolling(queued.jobId);
    } catch (err) {
      setError(err instanceof Error ? err : new Error(String(err)));
      setStage('idle');
      setBusy(false);
    }
  }

  return (
    <form onSubmit={(e) => void onSubmit(e)} className="card stack">
      <label className="field">
        <span className="field__label">Describe your animated video</span>
        <textarea
          className="input"
          name="prompt"
          rows={4}
          value={prompt}
          onChange={(e) => setPrompt(e.target.value)}
          maxLength={2048}
          placeholder="e.g., A 30-second product launch with bold headlines and a clean blue palette"
          required
        />
      </label>

      <div className="cluster" style={{ flexWrap: 'wrap', gap: 12 }}>
        <label className="field">
          <span className="field__label">Aspect ratio</span>
          <select className="input" name="aspectRatio" value={aspectRatio} onChange={(e) => setAspectRatio(e.target.value as AnimationRequestBody['aspectRatio'])}>
            <option value="16:9">16:9 (landscape)</option>
            <option value="9:16">9:16 (vertical)</option>
            <option value="1:1">1:1 (square)</option>
          </select>
        </label>
        <label className="field">
          <span className="field__label">Duration</span>
          <select className="input" name="durationSeconds" value={durationSeconds} onChange={(e) => setDurationSeconds(Number(e.target.value) as AnimationRequestBody['durationSeconds'])}>
            <option value={15}>15 seconds</option>
            <option value={30}>30 seconds</option>
            <option value={45}>45 seconds</option>
            <option value={60}>60 seconds</option>
            <option value={90}>90 seconds</option>
          </select>
        </label>
        <label className="field">
          <span className="field__label">Style</span>
          <select className="input" name="style" value={style} onChange={(e) => setStyle(e.target.value as AnimationRequestBody['style'])}>
            <option value="clean">Clean</option>
            <option value="playful">Playful</option>
            <option value="cinematic">Cinematic</option>
            <option value="technical">Technical</option>
            <option value="social">Social</option>
          </select>
        </label>
        <label className="field">
          <span className="field__label">Voiceover</span>
          <select className="input" name="voiceover" value={voiceover} onChange={(e) => setVoiceover(e.target.value as AnimationRequestBody['voiceover'])}>
            <option value="none">None</option>
            <option value="warm">Warm</option>
            <option value="neutral">Neutral</option>
            <option value="energetic">Energetic</option>
          </select>
        </label>
      </div>

      <label className="cluster" style={{ gap: 8 }}>
        <input
          type="checkbox"
          name="useGeneratedImages"
          checked={useGeneratedImages}
          onChange={(e) => setUseGeneratedImages(e.target.checked)}
        />
        <span>Generate image assets for the animation</span>
      </label>

      {stage !== 'idle' && STAGE_LABELS[stage] ? (
        <p className="ds-lede" aria-live="polite">{STAGE_LABELS[stage]}</p>
      ) : null}

      {estimateUsd !== null ? (
        <p>Estimated cost: ${estimateUsd.toFixed(3)}</p>
      ) : null}

      {generatedAssetCount !== null && generatedAssetCount > 0 ? (
        <p>Generated {generatedAssetCount} image asset{generatedAssetCount === 1 ? '' : 's'}.</p>
      ) : null}

      {jobId ? <p className="ds-caption">Job: {jobId}{renderStatus ? ` — ${renderStatus.status} (${renderStatus.progress}%)` : ''}</p> : null}

      {renderStatus?.videoId ? (
        <p>
          <Link to="/watch/$id" params={{ id: renderStatus.videoId }}>Watch your animation</Link>
        </p>
      ) : null}

      {error ? (
        <div className="alert alert--error" role="alert">
          <strong>Couldn&apos;t create the animation.</strong>
          <p style={{ marginTop: 4 }}>{error.message}</p>
          {error instanceof ApiError && error.status === 429 ? (
            <p style={{ marginTop: 4, fontSize: 'var(--text-sm)' }}>
              Rate limit: 30 studio generations per hour.
            </p>
          ) : null}
          {error instanceof ApiError && error.status === 413 ? (
            <p style={{ marginTop: 4, fontSize: 'var(--text-sm)' }}>
              Storage quota exceeded — free up space and retry.
            </p>
          ) : null}
        </div>
      ) : null}

      <button type="submit" className="btn btn--primary" disabled={!prompt.trim() || busy}>
        {busy ? <Spinner size={16} inline label="Creating…" /> : 'Create animated video'}
      </button>
    </form>
  );
}
