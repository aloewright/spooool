// ALO-153: persist the up-next auto-advance preference per device. Lives in
// localStorage so the toggle survives reloads, and read accessors are
// defensive — a corrupt or missing value falls back to the default (off) so
// the worst case is "video doesn't auto-play next" rather than a runtime
// throw on the watch page.

const STORAGE_KEY = 'spooool:up-next:auto-advance:v1';

export const AUTO_ADVANCE_DEFAULT = false;

export function loadAutoAdvance(storage: Storage = window.localStorage): boolean {
  try {
    const raw = storage.getItem(STORAGE_KEY);
    if (raw === null) return AUTO_ADVANCE_DEFAULT;
    return raw === 'true';
  } catch {
    // SecurityError when storage is disabled (Safari private mode, etc).
    return AUTO_ADVANCE_DEFAULT;
  }
}

export function saveAutoAdvance(value: boolean, storage: Storage = window.localStorage): void {
  try {
    storage.setItem(STORAGE_KEY, value ? 'true' : 'false');
  } catch {
    // best-effort: dropping the write just means the toggle resets next visit.
  }
}
