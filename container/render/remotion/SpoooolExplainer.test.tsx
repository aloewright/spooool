import { describe, expect, it } from 'vitest';
import { SpoooolExplainer, calculateExplainerDuration } from './SpoooolExplainer';

describe('SpoooolExplainer', () => {
  it('exports a React component', () => {
    expect(typeof SpoooolExplainer).toBe('function');
  });

  it('calculateExplainerDuration sums scene durations', () => {
    const d = calculateExplainerDuration([
      { type: 'title', durationFrames: 60, text: 'hi' },
      { type: 'beat', durationFrames: 120, text: 'mid' },
      { type: 'outro', durationFrames: 30, text: 'end' },
    ]);
    expect(d).toBe(210);
  });

  it('calculateExplainerDuration returns at least 1 frame for empty scenes', () => {
    expect(calculateExplainerDuration([])).toBe(1);
  });
});
