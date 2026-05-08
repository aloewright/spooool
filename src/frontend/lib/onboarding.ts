// ALO-178: per-device tracking of the first-run welcome flow. Lives in
// localStorage so we don't re-prompt a user who already chose to skip the
// flow on a given browser. The server still owns the source of truth for
// what the user has actually done (username set, avatar uploaded, video
// uploaded) — this state only gates *prompting*.

const STORAGE_KEY = 'spooool:onboarding:v1';

export type OnboardingStatus = 'pending' | 'skipped' | 'completed';

export interface OnboardingState {
  status: OnboardingStatus;
  /** Last completed step (0 = none, 1 = username, 2 = avatar, 3 = upload). */
  step: number;
}

export const ONBOARDING_DEFAULT: OnboardingState = {
  status: 'pending',
  step: 0,
};

export function loadOnboardingState(storage: Storage = window.localStorage): OnboardingState {
  try {
    const raw = storage.getItem(STORAGE_KEY);
    if (!raw) return ONBOARDING_DEFAULT;
    const parsed = JSON.parse(raw) as Partial<OnboardingState>;
    const status: OnboardingStatus =
      parsed.status === 'skipped' || parsed.status === 'completed' ? parsed.status : 'pending';
    const step = typeof parsed.step === 'number' ? parsed.step : 0;
    return { status, step };
  } catch {
    return ONBOARDING_DEFAULT;
  }
}

export function saveOnboardingState(
  state: OnboardingState,
  storage: Storage = window.localStorage,
): void {
  try {
    storage.setItem(STORAGE_KEY, JSON.stringify(state));
  } catch {
    // best-effort: a private-mode quota error just means we'll re-prompt next
    // session, which is the safest fallback.
  }
}

export function clearOnboardingState(storage: Storage = window.localStorage): void {
  try {
    storage.removeItem(STORAGE_KEY);
  } catch {
    // see saveOnboardingState — failure is non-fatal.
  }
}

/**
 * Decide whether the welcome flow should run for a freshly-loaded session.
 * Returns true only when the user has neither completed nor explicitly skipped
 * the flow on this device AND has no username set on the server. The username
 * check keeps us from prompting users who already configured their profile
 * on another device.
 */
export function shouldRunOnboarding(
  hasUsername: boolean,
  state: OnboardingState = loadOnboardingState(),
): boolean {
  if (hasUsername) return false;
  return state.status === 'pending';
}
