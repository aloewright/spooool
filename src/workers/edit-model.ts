// Shared E10/E11 edit data shapes. CaptionCue is consumed by the timeline
// editor and produced by POST /api/studio/captions (ALO-648).

export interface CaptionCue {
  startFrames: number;
  endFrames: number;
  text: string;
}

export const CAPTION_FPS = 30;

export interface TranscriptionSegment {
  start: number;
  end: number;
  text: string;
}

/** Map Whisper-style second offsets to frame-based CaptionCue[] at 30fps. */
export function mapSegmentsToCaptionCues(
  segments: TranscriptionSegment[],
  fps: number = CAPTION_FPS,
): CaptionCue[] {
  return segments
    .filter((s) => s.text.trim().length > 0)
    .map((s) => ({
      startFrames: Math.max(0, Math.round(s.start * fps)),
      endFrames: Math.max(1, Math.round(s.end * fps)),
      text: s.text.trim(),
    }));
}
