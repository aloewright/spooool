import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  getSafeStorage,
  hasCompletedOnboarding,
  markOnboardingComplete,
} from './onboarding';

function memoryStorage(): Storage & Record<string, unknown> {
  const map = new Map<string, string>();
  return {
    getItem: (k: string) => map.get(k) ?? null,
    setItem: (k: string, v: string) => {
      map.set(k, v);
    },
    removeItem: (k: string) => {
      map.delete(k);
    },
    clear: () => map.clear(),
    key: (i: number) => Array.from(map.keys())[i] ?? null,
    get length() {
      return map.size;
    },
  } as Storage & Record<string, unknown>;
}

describe('onboarding state', () => {
  it('reports false before completion', () => {
    const s = memoryStorage();
    expect(hasCompletedOnboarding('u1', s)).toBe(false);
  });

  it('reports true after markOnboardingComplete', () => {
    const s = memoryStorage();
    markOnboardingComplete('u1', s);
    expect(hasCompletedOnboarding('u1', s)).toBe(true);
  });

  it('keys completion by user id', () => {
    const s = memoryStorage();
    markOnboardingComplete('u1', s);
    expect(hasCompletedOnboarding('u1', s)).toBe(true);
    expect(hasCompletedOnboarding('u2', s)).toBe(false);
  });

  it('returns false when storage.getItem throws (SecurityError / TypeError)', () => {
    const throwing: Pick<Storage, 'getItem'> = {
      getItem: () => {
        throw new DOMException('storage disabled', 'SecurityError');
      },
    };
    expect(hasCompletedOnboarding('u1', throwing)).toBe(false);
  });

  it('swallows setItem errors so the caller does not crash', () => {
    const throwing: Pick<Storage, 'setItem'> = {
      setItem: () => {
        throw new DOMException('quota', 'QuotaExceededError');
      },
    };
    expect(() => markOnboardingComplete('u1', throwing)).not.toThrow();
  });
});

describe('getSafeStorage', () => {
  const originalDescriptor = Object.getOwnPropertyDescriptor(
    globalThis,
    'window',
  );

  afterEach(() => {
    if (originalDescriptor) {
      Object.defineProperty(globalThis, 'window', originalDescriptor);
    } else {
      // happy-dom may have set window; restore by deleting our override.
      // The next test that needs it can re-stub.
      delete (globalThis as { window?: unknown }).window;
    }
    vi.restoreAllMocks();
  });

  it('returns the real localStorage when the property access succeeds', () => {
    const fakeStorage = { getItem: vi.fn(), setItem: vi.fn() };
    Object.defineProperty(globalThis, 'window', {
      configurable: true,
      value: { localStorage: fakeStorage },
    });
    expect(getSafeStorage()).toBe(fakeStorage);
  });

  it('returns null when accessing window.localStorage throws', () => {
    Object.defineProperty(globalThis, 'window', {
      configurable: true,
      value: {
        get localStorage() {
          throw new DOMException('storage disabled', 'SecurityError');
        },
      },
    });
    expect(getSafeStorage()).toBeNull();
  });
});
