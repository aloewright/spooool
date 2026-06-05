import { describe, expect, it } from 'vitest';
import { containsForbiddenRemotionAnimationPattern } from './check-remotion-animation.mjs';

describe('check-remotion-animation', () => {
  it('flags CSS transitions and animation classes', () => {
    expect(containsForbiddenRemotionAnimationPattern('style={{ transition: "opacity 1s" }}')).toBe(true);
    expect(containsForbiddenRemotionAnimationPattern('className="animate-pulse"')).toBe(true);
    expect(containsForbiddenRemotionAnimationPattern('@keyframes fade')).toBe(true);
  });

  it('allows frame-driven Remotion primitives', () => {
    expect(containsForbiddenRemotionAnimationPattern('const frame = useCurrentFrame(); interpolate(frame, [0, 30], [0, 1]);')).toBe(false);
  });
});
