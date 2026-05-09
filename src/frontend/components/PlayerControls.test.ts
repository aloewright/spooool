import { describe, expect, it } from 'vitest';
import { formatHms } from './PlayerControls';

describe('formatHms', () => {
  it('renders mm:ss for sub-hour durations', () => {
    expect(formatHms(0)).toBe('0:00');
    expect(formatHms(5)).toBe('0:05');
    expect(formatHms(65)).toBe('1:05');
    expect(formatHms(599)).toBe('9:59');
  });

  it('switches to h:mm:ss once an hour is reached', () => {
    expect(formatHms(3600)).toBe('1:00:00');
    expect(formatHms(3661)).toBe('1:01:01');
    expect(formatHms(36000)).toBe('10:00:00');
  });

  it('floors fractional seconds', () => {
    expect(formatHms(12.7)).toBe('0:12');
  });

  it('coerces negatives to 0:00', () => {
    expect(formatHms(-10)).toBe('0:00');
  });
});
