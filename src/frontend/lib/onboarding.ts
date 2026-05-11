// ALO-178: first-run onboarding flow state.
//
// Onboarding is a 3-step welcome shown once per browser after the first
// signup: pick username → upload avatar → first-upload nudge. Each step
// can be skipped; either Finish or Skip marks the whole flow as done.
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
  return storage.getItem(key(userId)) === 'done';
}

export function markOnboardingComplete(
  userId: string,
  storage: Pick<Storage, 'setItem'>,
): void {
  storage.setItem(key(userId), 'done');
}
