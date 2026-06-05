import { describe, expect, it } from 'vitest';
import { formatCount } from './format';

describe('formatCount', () => {
  it('returns raw number below 1000', () => {
    expect(formatCount(0)).toBe('0');
    expect(formatCount(1)).toBe('1');
    expect(formatCount(999)).toBe('999');
  });

  it('formats thousands with one decimal', () => {
    expect(formatCount(1000)).toBe('1K');
    expect(formatCount(1200)).toBe('1.2K');
    expect(formatCount(9900)).toBe('9.9K');
  });

  it('drops decimal above 10K', () => {
    expect(formatCount(10_000)).toBe('10K');
    expect(formatCount(12_345)).toBe('12K');
    expect(formatCount(999_999)).toBe('999K');
  });

  it('formats millions with one decimal', () => {
    expect(formatCount(1_000_000)).toBe('1M');
    expect(formatCount(1_200_000)).toBe('1.2M');
    expect(formatCount(10_000_000)).toBe('10M');
  });
});
