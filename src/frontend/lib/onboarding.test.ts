import { describe, expect, it } from 'vitest';
import { hasCompletedOnboarding, markOnboardingComplete } from './onboarding';

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
});
