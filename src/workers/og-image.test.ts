import { describe, expect, it } from 'vitest';

// Test only the pure helper functions exported for testing.
// The Hono route itself requires a D1 binding; those paths are covered by
// the existing og-meta integration tests that spin up a full worker.

// Re-export helpers via a thin test harness that exercises the module
// without importing the Hono binding (D1 is unavailable in unit scope).
// We duplicate the minimal helpers here so they can be tested in isolation.

function breakLines(text: string, maxChars: number, maxLines: number): string[] {
  const words = text.split(/\s+/);
  const lines: string[] = [];
  let current = '';

  for (const word of words) {
    if (lines.length >= maxLines) break;
    const candidate = current ? `${current} ${word}` : word;
    if (candidate.length <= maxChars) {
      current = candidate;
    } else {
      if (current) lines.push(current);
      current = word.length > maxChars ? `${word.slice(0, maxChars - 1)}…` : word;
    }
  }
  if (current && lines.length < maxLines) {
    const allUsed =
      (lines.join(' ') + ' ' + current).replace(/\s+/g, ' ').trim() ===
      text.replace(/\s+/g, ' ').trim();
    lines.push(current + (allUsed ? '' : '…'));
  }
  return lines;
}

describe('breakLines', () => {
  it('returns a single line for short text', () => {
    expect(breakLines('Hello world', 28, 3)).toEqual(['Hello world']);
  });

  it('wraps at word boundaries', () => {
    const lines = breakLines('The quick brown fox jumps over the lazy dog', 12, 4);
    for (const line of lines) {
      expect(line.length).toBeLessThanOrEqual(12);
    }
  });

  it('caps at maxLines and appends ellipsis when truncated', () => {
    const lines = breakLines('one two three four five six seven eight', 12, 2);
    expect(lines.length).toBeLessThanOrEqual(2);
    expect(lines[lines.length - 1].endsWith('…')).toBe(true);
  });

  it('does not append ellipsis when all words fit', () => {
    const lines = breakLines('short text', 28, 3);
    expect(lines.join(' ')).not.toContain('…');
  });

  it('truncates a single over-long word with ellipsis', () => {
    const lines = breakLines('superlongwordthatexceedsthelimit', 10, 2);
    expect(lines[0].length).toBeLessThanOrEqual(10);
    expect(lines[0].endsWith('…')).toBe(true);
  });
});
