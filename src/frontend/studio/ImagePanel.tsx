// ImagePanel — AI image generation panel for the AI Studio page (ALO-646).
// Calls POST /api/studio/image with a text prompt and renders the returned
// dataUrl as a preview. When a videoId is provided, offers a "Set as video
// thumbnail" button that calls POST /api/videos/:id/thumbnail/from-asset.

import { FormEvent, useState } from 'react';
import { ApiError, postImage, setThumbnailFromAsset, type GeneratedImage } from './lib/studio-client';
import { Spinner } from '../create/Spinner';

export function ImagePanel({ videoId }: { videoId?: string }): JSX.Element {
  const [prompt, setPrompt] = useState('');
  const [busy, setBusy] = useState(false);
  const [image, setImage] = useState<GeneratedImage | null>(null);
  const [error, setError] = useState<ApiError | Error | null>(null);
  const [thumbDone, setThumbDone] = useState(false);

  async function onSubmit(e: FormEvent<HTMLFormElement>): Promise<void> {
    e.preventDefault();
    const p = prompt.trim();
    if (!p || busy) return;
    setError(null);
    setBusy(true);
    setThumbDone(false);
    setImage(null);
    try {
      setImage(await postImage(p));
    } catch (err) {
      setError(err instanceof Error ? err : new Error(String(err)));
    } finally {
      setBusy(false);
    }
  }

  async function onSetThumbnail(): Promise<void> {
    if (!image || !videoId || busy) return;
    setBusy(true);
    setError(null);
    try {
      await setThumbnailFromAsset(videoId, image.assetId);
      setThumbDone(true);
    } catch (err) {
      setError(err instanceof Error ? err : new Error(String(err)));
    } finally {
      setBusy(false);
    }
  }

  return (
    <form onSubmit={(e) => void onSubmit(e)} className="card stack">
      <label className="field">
        <span className="field__label">Generate an image (thumbnail or b-roll)</span>
        <textarea
          className="input"
          rows={3}
          value={prompt}
          onChange={(e) => setPrompt(e.target.value)}
          maxLength={2048}
          placeholder="e.g., neon-lit city skyline at dusk, cinematic, 16:9"
          required
        />
      </label>
      {error ? (
        <div className="alert alert--error" role="alert">
          <strong>Couldn't generate the image.</strong>
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
      {image && !error ? (
        <div className="stack">
          <img
            src={image.dataUrl}
            alt="Generated"
            loading="lazy"
            decoding="async"
            style={{ width: '100%', aspectRatio: '16 / 9', objectFit: 'cover', borderRadius: 8 }}
          />
          {videoId ? (
            <button
              type="button"
              className="btn"
              disabled={busy || thumbDone}
              onClick={() => void onSetThumbnail()}
            >
              {thumbDone ? 'Thumbnail set ✓' : 'Set as video thumbnail'}
            </button>
          ) : null}
        </div>
      ) : null}
      <button type="submit" className="btn btn--primary" disabled={!prompt.trim() || busy}>
        {busy ? <Spinner size={16} inline label="Generating…" /> : 'Generate image'}
      </button>
    </form>
  );
}
