import React, { useEffect, useRef } from "react";
import { Player } from "@remotion/player";
import { AbsoluteFill, Sequence, Video } from "remotion";

/** Frames per take used in the preview. The actual take may be longer or
 *  shorter — the <Video> element will stop naturally when the source ends.
 *  We use the caller-supplied `expectedFrames` when available so the
 *  scrubber tracks reality; otherwise fall back to 10 min at 30 fps. */
const FALLBACK_FRAMES = 30 * 60 * 10; // 10 minutes

/**
 * Inline composition that renders blob-URL takes sequentially.
 * This is intentionally simpler than the server-side SpoooolVideo:
 * no intros, no overlays, no captions. The goal is a quick "does
 * everything look ok" sanity check before submitting a render job.
 */
function SpoooolVideoPreview({
  takes,
  framesPerTake,
}: {
  takes: string[];
  framesPerTake: number;
}): JSX.Element {
  return (
    <AbsoluteFill style={{ backgroundColor: "black" }}>
      {takes.map((src, i) => (
        <Sequence
          key={i}
          from={i * framesPerTake}
          durationInFrames={framesPerTake}
        >
          {/* src is a blob: URL — use directly, no staticFile() needed */}
          <Video src={src} />
        </Sequence>
      ))}
    </AbsoluteFill>
  );
}

export interface CompositionPreviewProps {
  /**
   * Browser-playable URLs (blob: URLs created from the local recording).
   * The server-side render uses R2 paths instead; this preview uses blob
   * URLs because @remotion/player can't fetch private R2 objects.
   */
  takeUrls: string[];
  /**
   * Actual expected frame count for the session (from RecordingStatus).
   * Used to size the player scrubber accurately. Falls back to 10 min.
   */
  expectedFrames?: number;
}

export function CompositionPreview({
  takeUrls,
  expectedFrames,
}: CompositionPreviewProps): JSX.Element {
  if (takeUrls.length === 0) {
    return (
      <div
        style={{
          padding: 16,
          opacity: 0.7,
          color: "white",
          fontFamily: "sans-serif",
        }}
      >
        Record at least one take to preview.
      </div>
    );
  }

  const framesPerTake =
    expectedFrames != null && expectedFrames > 0
      ? Math.ceil(expectedFrames)
      : FALLBACK_FRAMES;

  const totalFrames = takeUrls.length * framesPerTake;

  return (
    <Player
      component={SpoooolVideoPreview}
      durationInFrames={totalFrames}
      compositionWidth={1920}
      compositionHeight={1080}
      fps={30}
      style={{ width: "100%", aspectRatio: "16 / 9" }}
      controls
      inputProps={{ takes: takeUrls, framesPerTake }}
    />
  );
}

/**
 * Hook that resolves a list of FinishedRecording-like blobs into blob URLs.
 * Revokes the URLs on unmount to avoid memory leaks.
 */
export function useTakeUrls(
  blobGetters: Array<() => Promise<Blob>>,
): string[] | null {
  const [urls, setUrls] = React.useState<string[] | null>(null);
  // Track which getters we've already resolved so we don't re-fetch on
  // every render. Using a ref avoids adding `urls` to the effect deps.
  const resolvedRef = useRef(false);

  useEffect(() => {
    if (resolvedRef.current || blobGetters.length === 0) {
      return;
    }
    resolvedRef.current = true;

    let cancelled = false;
    const created: string[] = [];

    Promise.all(blobGetters.map((get) => get()))
      .then((blobs) => {
        if (cancelled) return;
        const blobUrls = blobs.map((b) => URL.createObjectURL(b));
        created.push(...blobUrls);
        setUrls(blobUrls);
      })
      .catch((err) => {
        console.error("[CompositionPreview] Failed to create blob URLs", err);
      });

    return () => {
      cancelled = true;
      created.forEach((u) => URL.revokeObjectURL(u));
    };
  }, [blobGetters]);

  return urls;
}
