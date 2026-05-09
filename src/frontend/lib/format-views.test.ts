import { describe, expect, it } from 'vitest';
import { formatViewCount, formatViews } from './format-views';

describe('formatViewCount', () => {
  it('returns the integer verbatim under 1000', () => {
    expect(formatViewCount(0)).toBe('0');
    expect(formatViewCount(1)).toBe('1');
    expect(formatViewCount(999)).toBe('999');
  });

  it('uses K with one decimal in the [1K, 100K) range', () => {
    expect(formatViewCount(1_000)).toBe('1K');
    expect(formatViewCount(1_200)).toBe('1.2K');
    expect(formatViewCount(12_345)).toBe('12.3K');
  });

  it('drops decimals once at 100K or higher', () => {
    expect(formatViewCount(100_000)).toBe('100K');
    expect(formatViewCount(987_654)).toBe('987K');
  });

  it('uses M and B for larger counts', () => {
    expect(formatViewCount(1_500_000)).toBe('1.5M');
    expect(formatViewCount(123_400_000)).toBe('123M');
    expect(formatViewCount(2_300_000_000)).toBe('2.3B');
  });

  it('coerces null / NaN / negative to 0', () => {
    expect(formatViewCount(null)).toBe('0');
    expect(formatViewCount(undefined)).toBe('0');
    expect(formatViewCount(Number.NaN)).toBe('0');
    expect(formatViewCount(-42)).toBe('0');
  });
});

describe('formatViews', () => {
  it('renders singular and plural correctly', () => {
    expect(formatViews(0)).toBe('0 views');
    expect(formatViews(1)).toBe('1 view');
    expect(formatViews(2)).toBe('2 views');
  });

  it('keeps the abbreviated count plural', () => {
    // Even a single thousand is "1K views" — never "1K view".
    expect(formatViews(1_000)).toBe('1K views');
  });
});
