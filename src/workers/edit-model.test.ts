import { describe, expect, it } from 'vitest';
import { mapSegmentsToCaptionCues, CAPTION_FPS } from './edit-model';

describe('mapSegmentsToCaptionCues (ALO-648)', () => {
  it('maps second offsets to 30fps frame ranges', () => {
    const cues = mapSegmentsToCaptionCues([
      { start: 0, end: 1, text: 'Hello' },
      { start: 1.5, end: 2.25, text: 'world' },
    ]);
    expect(cues).toEqual([
      { startFrames: 0, endFrames: 30, text: 'Hello' },
      { startFrames: 45, endFrames: 68, text: 'world' },
    ]);
  });

  it('drops empty segments', () => {
    expect(mapSegmentsToCaptionCues([{ start: 0, end: 1, text: '   ' }])).toEqual([]);
  });

  it('respects a custom fps', () => {
    const cues = mapSegmentsToCaptionCues([{ start: 1, end: 2, text: 'x' }], 24);
    expect(cues[0]).toEqual({ startFrames: 24, endFrames: 48, text: 'x' });
    expect(CAPTION_FPS).toBe(30);
  });
});
