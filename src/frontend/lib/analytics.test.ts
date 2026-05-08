import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  __resetForTests,
  identify,
  initAnalytics,
  isAnalyticsAllowedFor,
  readAnalyticsConfig,
  reset,
  track,
} from './analytics';
import { LEGAL_VERSIONS } from './legal';

vi.mock('posthog-js', () => {
  const mock = {
    init: vi.fn(),
    capture: vi.fn(),
    identify: vi.fn(),
    reset: vi.fn(),
  };
  return { default: mock };
});

import posthog from 'posthog-js';

afterEach(() => {
  __resetForTests();
  vi.clearAllMocks();
});

describe('readAnalyticsConfig', () => {
  it('reports disabled when VITE_POSTHOG_KEY is unset', () => {
    const cfg = readAnalyticsConfig();
    // Vitest sets PROD=false by default; either way, no key means disabled.
    expect(cfg.enabled).toBe(false);
  });

  it('falls back to the cloud host when none is configured', () => {
    const cfg = readAnalyticsConfig();
    expect(cfg.host).toBe('https://us.i.posthog.com');
  });
});

describe('initAnalytics', () => {
  it('is a no-op when disabled', () => {
    initAnalytics({ apiKey: undefined, host: undefined, enabled: false });
    expect(posthog.init).not.toHaveBeenCalled();
  });

  it('is a no-op when apiKey is missing even if enabled=true', () => {
    initAnalytics({ apiKey: undefined, host: undefined, enabled: true });
    expect(posthog.init).not.toHaveBeenCalled();
  });

  it('initialises posthog when enabled with a key', () => {
    initAnalytics({
      apiKey: 'phc_test',
      host: 'https://us.i.posthog.com',
      enabled: true,
    });
    expect(posthog.init).toHaveBeenCalledTimes(1);
    expect(posthog.init).toHaveBeenCalledWith(
      'phc_test',
      expect.objectContaining({ api_host: 'https://us.i.posthog.com' }),
    );
  });

  it('is idempotent — second call does not re-init', () => {
    const cfg = { apiKey: 'phc_test', host: 'https://x', enabled: true };
    initAnalytics(cfg);
    initAnalytics(cfg);
    expect(posthog.init).toHaveBeenCalledTimes(1);
  });
});

describe('isAnalyticsAllowedFor (consent gate)', () => {
  it('defaults to allowed when no record exists (non-EU baseline / no decision yet)', () => {
    expect(isAnalyticsAllowedFor(null)).toBe(true);
  });

  it('blocks analytics when the visitor has explicitly rejected', () => {
    expect(
      isAnalyticsAllowedFor({
        choice: 'rejected',
        version: LEGAL_VERSIONS.cookies,
        decidedAt: '2026-05-08T00:00:00.000Z',
      }),
    ).toBe(false);
  });

  it('allows analytics when the visitor has accepted at the current version', () => {
    expect(
      isAnalyticsAllowedFor({
        choice: 'accepted',
        version: LEGAL_VERSIONS.cookies,
        decidedAt: '2026-05-08T00:00:00.000Z',
      }),
    ).toBe(true);
  });

  it('blocks analytics for a stale-version "accepted" record until re-prompt', () => {
    // Privacy-leaning default: an acceptance against an older policy version
    // is not considered fresh consent. The EU banner will re-prompt; outside
    // the EEA we still wait for an explicit re-acceptance after a bump.
    expect(
      isAnalyticsAllowedFor({
        choice: 'accepted',
        version: '1900-01-01',
        decidedAt: '1900-01-01T00:00:00.000Z',
      }),
    ).toBe(false);
  });
});

describe('track / identify / reset', () => {
  it('do nothing before init (no posthog calls)', () => {
    track('demo', { x: 1 });
    identify('user-1');
    reset();
    expect(posthog.capture).not.toHaveBeenCalled();
    expect(posthog.identify).not.toHaveBeenCalled();
    expect(posthog.reset).not.toHaveBeenCalled();
  });

  it('proxies through to posthog after init', () => {
    initAnalytics({ apiKey: 'phc_test', host: 'https://x', enabled: true });
    track('signup', { source: 'invite' });
    identify('user-1', { plan: 'free' });
    reset();
    expect(posthog.capture).toHaveBeenCalledWith('signup', { source: 'invite' });
    expect(posthog.identify).toHaveBeenCalledWith('user-1', { plan: 'free' });
    expect(posthog.reset).toHaveBeenCalled();
  });
});
