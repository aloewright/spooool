import { describe, expect, it } from 'vitest';
import { formatDuration, formatMilliseconds } from './format-time';

describe('formatDuration', () => {
  it('formats sub-second durations with one decimal', () => {
    expect(formatDuration(0)).toBe('0.0s');
    expect(formatDuration(400)).toBe('0.4s');
    expect(formatDuration(999)).toBe('1.0s');
  });

  it('formats seconds when under a minute', () => {
    expect(formatDuration(1000)).toBe('1s');
    expect(formatDuration(12_000)).toBe('12s');
    expect(formatDuration(59_000)).toBe('59s');
  });

  it('formats minutes and seconds when under an hour', () => {
    expect(formatDuration(60_000)).toBe('1m');
    expect(formatDuration(61_000)).toBe('1m 1s');
    expect(formatDuration(185_000)).toBe('3m 5s');
  });

  it('formats hours and minutes when an hour or more', () => {
    expect(formatDuration(3_600_000)).toBe('1h');
    expect(formatDuration(3_660_000)).toBe('1h 1m');
    expect(formatDuration(7_440_000)).toBe('2h 4m');
  });

  it('throws TypeError for negative or non-finite input', () => {
    expect(() => formatDuration(-1)).toThrow(TypeError);
    expect(() => formatDuration(Number.POSITIVE_INFINITY)).toThrow(TypeError);
    expect(() => formatDuration(Number.NEGATIVE_INFINITY)).toThrow(TypeError);
    expect(() => formatDuration(Number.NaN)).toThrow(TypeError);
    expect(() => formatDuration('1000' as unknown as number)).toThrow(TypeError);
  });
});

describe('formatMilliseconds', () => {
  it('formats zero as 00:00', () => {
    expect(formatMilliseconds(0)).toBe('00:00');
  });

  it('truncates sub-second values and pads to two digits', () => {
    expect(formatMilliseconds(400)).toBe('00:00');
    expect(formatMilliseconds(999)).toBe('00:00');
    expect(formatMilliseconds(1000)).toBe('00:01');
    expect(formatMilliseconds(59000)).toBe('00:59');
  });

  it('formats minutes and seconds', () => {
    expect(formatMilliseconds(60000)).toBe('01:00');
    expect(formatMilliseconds(61000)).toBe('01:01');
    expect(formatMilliseconds(185000)).toBe('03:05');
  });

  it('includes hours when present', () => {
    expect(formatMilliseconds(3600000)).toBe('01:00:00');
    expect(formatMilliseconds(3661000)).toBe('01:01:01');
    expect(formatMilliseconds(7200000)).toBe('02:00:00');
  });

  it('does not wrap at 24 hours', () => {
    expect(formatMilliseconds(86400000)).toBe('24:00:00');
    expect(formatMilliseconds(90061000)).toBe('25:01:01');
  });
});
