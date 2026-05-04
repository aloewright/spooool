import { describe, expect, it } from 'vitest';
import { AUTO_ADVANCE_DEFAULT, loadAutoAdvance, saveAutoAdvance } from './auto-advance';

class MemoryStorage implements Storage {
  private store = new Map<string, string>();
  get length(): number {
    return this.store.size;
  }
  clear(): void {
    this.store.clear();
  }
  getItem(key: string): string | null {
    return this.store.get(key) ?? null;
  }
  key(index: number): string | null {
    return [...this.store.keys()][index] ?? null;
  }
  removeItem(key: string): void {
    this.store.delete(key);
  }
  setItem(key: string, value: string): void {
    this.store.set(key, value);
  }
}

class ThrowingStorage implements Storage {
  readonly length = 0;
  clear(): void {
    throw new Error('disabled');
  }
  getItem(): string | null {
    throw new Error('disabled');
  }
  key(): string | null {
    throw new Error('disabled');
  }
  removeItem(): void {
    throw new Error('disabled');
  }
  setItem(): void {
    throw new Error('disabled');
  }
}

describe('loadAutoAdvance', () => {
  it('returns the default when no value is stored', () => {
    const s = new MemoryStorage();
    expect(loadAutoAdvance(s)).toBe(AUTO_ADVANCE_DEFAULT);
  });

  it('returns true after saveAutoAdvance(true)', () => {
    const s = new MemoryStorage();
    saveAutoAdvance(true, s);
    expect(loadAutoAdvance(s)).toBe(true);
  });

  it('returns false after saveAutoAdvance(false)', () => {
    const s = new MemoryStorage();
    saveAutoAdvance(false, s);
    expect(loadAutoAdvance(s)).toBe(false);
  });

  it('treats malformed values as the default (off)', () => {
    const s = new MemoryStorage();
    s.setItem('spooool:up-next:auto-advance:v1', 'banana');
    expect(loadAutoAdvance(s)).toBe(false);
  });

  it('falls back to default when storage throws (private mode)', () => {
    const s = new ThrowingStorage();
    expect(loadAutoAdvance(s)).toBe(AUTO_ADVANCE_DEFAULT);
  });
});

describe('saveAutoAdvance', () => {
  it('persists the value', () => {
    const s = new MemoryStorage();
    saveAutoAdvance(true, s);
    expect(s.getItem('spooool:up-next:auto-advance:v1')).toBe('true');
  });

  it('overwrites a prior value', () => {
    const s = new MemoryStorage();
    saveAutoAdvance(true, s);
    saveAutoAdvance(false, s);
    expect(loadAutoAdvance(s)).toBe(false);
  });

  it('swallows storage errors so the toggle never throws', () => {
    const s = new ThrowingStorage();
    expect(() => saveAutoAdvance(true, s)).not.toThrow();
  });
});
