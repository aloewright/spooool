// ALO-179: shared metadata for the legal pages (ToS, Privacy, DMCA, Cookies)
// and the cookie-consent storage helpers consumed by the EU consent banner
// and the analytics gate. Centralised so the "Last updated" line on each
// page, the version stamped into consent records, and the analytics gate
// stay in lockstep.

// Bumping any of these version strings is the signal that the corresponding
// document has materially changed. The consent banner stores the version it
// was accepted against, so a later bump can re-prompt EU visitors without
// nuking everyone's preference.
export const LEGAL_VERSIONS = {
  tos: '2026-05-08',
  privacy: '2026-05-08',
  dmca: '2026-05-08',
  cookies: '2026-05-08',
} as const;

export type LegalDocument = keyof typeof LEGAL_VERSIONS;

// EEA + UK + EFTA states. The cookie consent banner is shown when the
// visitor's CF-resolved country is in this list. Kept inline so the
// frontend doesn't need a network round-trip to learn the list.
export const EU_EEA_COUNTRIES: readonly string[] = [
  // EU 27
  'AT',
  'BE',
  'BG',
  'HR',
  'CY',
  'CZ',
  'DK',
  'EE',
  'FI',
  'FR',
  'DE',
  'GR',
  'HU',
  'IE',
  'IT',
  'LV',
  'LT',
  'LU',
  'MT',
  'NL',
  'PL',
  'PT',
  'RO',
  'SK',
  'SI',
  'ES',
  'SE',
  // EEA non-EU
  'IS',
  'LI',
  'NO',
  // UK (post-Brexit, still GDPR-aligned)
  'GB',
];

export function isEuCountry(country: string | null | undefined): boolean {
  if (!country) return false;
  return EU_EEA_COUNTRIES.includes(country.toUpperCase());
}

// localStorage key. The value is JSON-encoded `ConsentRecord`.
export const CONSENT_STORAGE_KEY = 'spooool.cookie-consent';

export type ConsentChoice = 'accepted' | 'rejected';

export interface ConsentRecord {
  choice: ConsentChoice;
  // Version string of the cookie policy the user accepted against. If the
  // policy is bumped past this value, the banner re-prompts.
  version: string;
  // ISO timestamp the user clicked accept/reject. Stored so we can show
  // "you accepted on …" in the cookie settings UI later.
  decidedAt: string;
}

// Pure parser separated from `readConsent` so it can be unit-tested without
// a localStorage mock.
export function parseConsentRecord(raw: string | null): ConsentRecord | null {
  if (!raw) return null;
  try {
    const parsed = JSON.parse(raw) as unknown;
    if (
      parsed === null ||
      typeof parsed !== 'object' ||
      !('choice' in parsed) ||
      !('version' in parsed) ||
      !('decidedAt' in parsed)
    ) {
      return null;
    }
    const r = parsed as Record<string, unknown>;
    if (r.choice !== 'accepted' && r.choice !== 'rejected') return null;
    if (typeof r.version !== 'string' || typeof r.decidedAt !== 'string') return null;
    return { choice: r.choice, version: r.version, decidedAt: r.decidedAt };
  } catch {
    return null;
  }
}

export function readConsent(storage: Storage | undefined = safeStorage()): ConsentRecord | null {
  if (!storage) return null;
  return parseConsentRecord(storage.getItem(CONSENT_STORAGE_KEY));
}

export function writeConsent(
  choice: ConsentChoice,
  storage: Storage | undefined = safeStorage(),
  now: () => Date = () => new Date(),
): ConsentRecord {
  const record: ConsentRecord = {
    choice,
    version: LEGAL_VERSIONS.cookies,
    decidedAt: now().toISOString(),
  };
  if (storage) {
    storage.setItem(CONSENT_STORAGE_KEY, JSON.stringify(record));
  }
  return record;
}

export function clearConsent(storage: Storage | undefined = safeStorage()): void {
  if (storage) storage.removeItem(CONSENT_STORAGE_KEY);
}

// True only when the user has explicitly accepted against the *current*
// cookie-policy version. A stale record (older version) counts as "no
// decision" so we re-prompt.
export function hasFreshAcceptedConsent(record: ConsentRecord | null): boolean {
  return record?.choice === 'accepted' && record.version === LEGAL_VERSIONS.cookies;
}

function safeStorage(): Storage | undefined {
  // SSR / non-browser execution paths and Safari private mode (where
  // localStorage throws on access) — fall back to "no storage", same as
  // a fresh visitor with no decision.
  if (typeof window === 'undefined') return undefined;
  try {
    return window.localStorage;
  } catch {
    return undefined;
  }
}
