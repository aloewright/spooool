// ALO-178: first-run onboarding flow state.
//
// Onboarding is a 3-step welcome shown once per browser after the first
// signup: pick username → upload avatar → first-upload nudge. Each step
// is skippable; whichever button closes the flow (the final-step Skip /
// "Maybe later" / "Upload a video", or any step's Continue once we've
// reached the end) marks the whole flow as done.
//
// Completion is keyed by user id so a shared device prompts the next
// person who signs up. Reads are cheap (single localStorage hit); the
// helpers are split out so unit tests can run without a DOM Routes setup.

const STORAGE_PREFIX = 'onboarding:v1:';

function key(userId: string): string {
  return `${STORAGE_PREFIX}${userId}`;
}

export function hasCompletedOnboarding(
  userId: string,
  storage: Pick<Storage, 'getItem'>,
): boolean {
  try {
    return storage.getItem(key(userId)) === 'done';
  } catch {
    // Same failure modes as setItem (private mode / disabled storage).
    // Treat as "not completed" so the flow re-runs rather than crashing.
    return false;
  }
}

export function markOnboardingComplete(
  userId: string,
  storage: Pick<Storage, 'setItem'>,
): void {
  try {
    storage.setItem(key(userId), 'done');
  } catch {
    // SecurityError (private mode) / QuotaExceededError are both
    // recoverable here — the user just gets re-prompted next visit.
  }
}

// Chrome with storage disabled throws SecurityError on the property
// access `window.localStorage` itself, before any get/setItem call.
// Centralising the safe lookup here lets call sites pass the result
// (or null) into the helpers above without sprinkling try/catch.
export function getSafeStorage(): Storage | null {
  try {
    return window.localStorage;
  } catch {
    return null;
  }
}
