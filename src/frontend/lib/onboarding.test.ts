import { beforeEach, describe, expect, it } from 'vitest';
import {
  ONBOARDING_DEFAULT,
  clearOnboardingState,
  loadOnboardingState,
  saveOnboardingState,
  shouldRunOnboarding,
  type OnboardingState,
} from './onboarding';

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

let storage: MemoryStorage;

beforeEach(() => {
  storage = new MemoryStorage();
});

describe('loadOnboardingState', () => {
  it('returns the default state when nothing is stored', () => {
    expect(loadOnboardingState(storage)).toEqual(ONBOARDING_DEFAULT);
  });

  it('reads back what was saved', () => {
    const state: OnboardingState = { status: 'completed', step: 3 };
    saveOnboardingState(state, storage);
    expect(loadOnboardingState(storage)).toEqual(state);
  });

  it('falls back to default on corrupt JSON', () => {
    storage.setItem('spooool:onboarding:v1', '{not-json');
    expect(loadOnboardingState(storage)).toEqual(ONBOARDING_DEFAULT);
  });

  it('coerces unknown status values to pending', () => {
    storage.setItem('spooool:onboarding:v1', JSON.stringify({ status: 'whatever', step: 2 }));
    expect(loadOnboardingState(storage)).toEqual({ status: 'pending', step: 2 });
  });

  it('treats throwing storage as default', () => {
    expect(loadOnboardingState(new ThrowingStorage())).toEqual(ONBOARDING_DEFAULT);
  });
});

describe('saveOnboardingState', () => {
  it('swallows storage errors', () => {
    expect(() =>
      saveOnboardingState({ status: 'skipped', step: 1 }, new ThrowingStorage()),
    ).not.toThrow();
  });
});

describe('clearOnboardingState', () => {
  it('removes the stored state', () => {
    saveOnboardingState({ status: 'skipped', step: 1 }, storage);
    clearOnboardingState(storage);
    expect(loadOnboardingState(storage)).toEqual(ONBOARDING_DEFAULT);
  });

  it('swallows storage errors', () => {
    expect(() => clearOnboardingState(new ThrowingStorage())).not.toThrow();
  });
});

describe('shouldRunOnboarding', () => {
  it('skips when the user already has a username server-side', () => {
    expect(shouldRunOnboarding(true, ONBOARDING_DEFAULT)).toBe(false);
  });

  it('runs when pending and no username yet', () => {
    expect(shouldRunOnboarding(false, ONBOARDING_DEFAULT)).toBe(true);
  });

  it('does not re-run after a skip', () => {
    expect(shouldRunOnboarding(false, { status: 'skipped', step: 1 })).toBe(false);
  });

  it('does not re-run after completion', () => {
    expect(shouldRunOnboarding(false, { status: 'completed', step: 3 })).toBe(false);
  });
});
