import { describe, expect, it } from 'vitest';
import {
  EU_EEA_COUNTRIES,
  LEGAL_VERSIONS,
  hasFreshAcceptedConsent,
  isEuCountry,
  parseConsentRecord,
  readConsent,
  writeConsent,
} from './legal';

function memoryStorage(): Storage {
  const map = new Map<string, string>();
  return {
    get length(): number {
      return map.size;
    },
    clear: () => map.clear(),
    getItem: (k: string) => map.get(k) ?? null,
    key: (i: number) => Array.from(map.keys())[i] ?? null,
    removeItem: (k: string) => {
      map.delete(k);
    },
    setItem: (k: string, v: string) => {
      map.set(k, v);
    },
  };
}

describe('isEuCountry', () => {
  it('returns true for EU member states', () => {
    expect(isEuCountry('DE')).toBe(true);
    expect(isEuCountry('FR')).toBe(true);
    expect(isEuCountry('IT')).toBe(true);
  });

  it('includes EEA non-EU and the UK', () => {
    expect(isEuCountry('NO')).toBe(true);
    expect(isEuCountry('IS')).toBe(true);
    expect(isEuCountry('GB')).toBe(true);
  });

  it('returns false for non-EU countries and falsy input', () => {
    expect(isEuCountry('US')).toBe(false);
    expect(isEuCountry('JP')).toBe(false);
    expect(isEuCountry(null)).toBe(false);
    expect(isEuCountry(undefined)).toBe(false);
    expect(isEuCountry('')).toBe(false);
  });

  it('is case-insensitive', () => {
    expect(isEuCountry('de')).toBe(true);
    expect(isEuCountry('gb')).toBe(true);
  });

  it('exposes a stable list of countries', () => {
    expect(EU_EEA_COUNTRIES.length).toBeGreaterThanOrEqual(30);
  });
});

describe('parseConsentRecord', () => {
  it('returns null for null / invalid JSON', () => {
    expect(parseConsentRecord(null)).toBeNull();
    expect(parseConsentRecord('not json {{')).toBeNull();
  });

  it('rejects records missing required fields', () => {
    expect(parseConsentRecord(JSON.stringify({}))).toBeNull();
    expect(parseConsentRecord(JSON.stringify({ choice: 'accepted' }))).toBeNull();
    expect(
      parseConsentRecord(JSON.stringify({ choice: 'maybe', version: 'x', decidedAt: 'y' })),
    ).toBeNull();
  });

  it('parses well-formed records', () => {
    const raw = JSON.stringify({
      choice: 'accepted',
      version: '2026-05-08',
      decidedAt: '2026-05-08T00:00:00.000Z',
    });
    expect(parseConsentRecord(raw)).toEqual({
      choice: 'accepted',
      version: '2026-05-08',
      decidedAt: '2026-05-08T00:00:00.000Z',
    });
  });
});

describe('readConsent / writeConsent', () => {
  it('round-trips an accepted record', () => {
    const storage = memoryStorage();
    writeConsent('accepted', storage, () => new Date('2026-05-08T12:00:00.000Z'));
    const record = readConsent(storage);
    expect(record).toEqual({
      choice: 'accepted',
      version: LEGAL_VERSIONS.cookies,
      decidedAt: '2026-05-08T12:00:00.000Z',
    });
  });

  it('returns null when nothing is stored', () => {
    expect(readConsent(memoryStorage())).toBeNull();
  });

  it('writeConsent is a no-op when storage is unavailable', () => {
    expect(() => writeConsent('rejected', undefined)).not.toThrow();
  });
});

describe('hasFreshAcceptedConsent', () => {
  it('is false for null / rejected / stale-version records', () => {
    expect(hasFreshAcceptedConsent(null)).toBe(false);
    expect(
      hasFreshAcceptedConsent({
        choice: 'rejected',
        version: LEGAL_VERSIONS.cookies,
        decidedAt: 'x',
      }),
    ).toBe(false);
    expect(
      hasFreshAcceptedConsent({ choice: 'accepted', version: '1900-01-01', decidedAt: 'x' }),
    ).toBe(false);
  });

  it('is true only for accepted records at the current version', () => {
    expect(
      hasFreshAcceptedConsent({
        choice: 'accepted',
        version: LEGAL_VERSIONS.cookies,
        decidedAt: 'x',
      }),
    ).toBe(true);
  });
});
