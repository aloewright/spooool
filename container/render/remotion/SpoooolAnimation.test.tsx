import { describe, expect, it } from 'vitest';
import {
  DEFAULT_ANIMATION_PROJECT,
  SpoooolAnimation,
  calculateAnimationMetadata,
  calculateAnimationDuration,
} from './SpoooolAnimation';
import { resolveAnimationProps } from './animation/animation-spec';

describe('SpoooolAnimation', () => {
  it('exports a React component', () => {
    expect(typeof SpoooolAnimation).toBe('function');
  });

  it('calculates duration from validated props', () => {
    expect(calculateAnimationDuration(DEFAULT_ANIMATION_PROJECT)).toBe(DEFAULT_ANIMATION_PROJECT.durationFrames);
  });

  it('calculates dimensions from validated props', () => {
    expect(calculateAnimationMetadata({ animation: DEFAULT_ANIMATION_PROJECT })).toMatchObject({
      width: 1920,
      height: 1080,
      durationInFrames: DEFAULT_ANIMATION_PROJECT.durationFrames,
    });
  });

  it('rejects malformed container props clearly', () => {
    expect(() => resolveAnimationProps({ animation: { version: 1, scenes: [] } })).toThrow(/animation/i);
  });
});
