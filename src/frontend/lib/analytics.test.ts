// @vitest-environment happy-dom
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  __resetForTests,
  identify,
  initAnalytics,
  readAnalyticsConfig,
  reset,
  track,
  withdrawAnalyticsConsent,
} from './analytics';

vi.mock('posthog-js', () => {
  const mock = {
    init: vi.fn(),
    capture: vi.fn(),
    identify: vi.fn(),
    reset: vi.fn(),
    opt_out_capturing: vi.fn(),
    opt_in_capturing: vi.fn(),
  };
  return { default: mock };
});

import posthog from 'posthog-js';

function acceptAnalyticsConsent(): void {
  window.localStorage.setItem('cookie-consent:v1', 'accepted');
}

function stubProductionBuild(): void {
  vi.stubEnv('PROD', true);
  vi.stubEnv('VITE_POSTHOG_KEY', 'phc_test');
}

afterEach(() => {
  __resetForTests();
  vi.clearAllMocks();
  vi.unstubAllEnvs();
  window.localStorage.clear();
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

  it('is a no-op without cookie consent', () => {
    initAnalytics({
      apiKey: 'phc_test',
      host: 'https://us.i.posthog.com',
      enabled: true,
    });
    expect(posthog.init).not.toHaveBeenCalled();
  });

  it('is a no-op outside production even when explicitly enabled with consent', () => {
    vi.stubEnv('PROD', false);
    acceptAnalyticsConsent();
    initAnalytics({ apiKey: 'phc_test', host: 'https://x', enabled: true });
    expect(posthog.init).not.toHaveBeenCalled();
  });

  it('is a no-op when the build-time key is absent despite supplied configuration', () => {
    vi.stubEnv('PROD', true);
    vi.stubEnv('VITE_POSTHOG_KEY', '');
    acceptAnalyticsConsent();
    initAnalytics({ apiKey: 'phc_test', host: 'https://x', enabled: true });
    expect(posthog.init).not.toHaveBeenCalled();
  });

  it('initialises posthog when enabled with a key', () => {
    stubProductionBuild();
    acceptAnalyticsConsent();
    initAnalytics({
      apiKey: 'phc_test',
      host: 'https://us.i.posthog.com',
      enabled: true,
    });
    expect(posthog.init).toHaveBeenCalledTimes(1);
    expect(posthog.init).toHaveBeenCalledWith(
      'phc_test',
      expect.objectContaining({
        api_host: 'https://us.i.posthog.com',
        defaults: '2026-05-30',
        capture_pageview: 'history_change',
        capture_pageleave: true,
        autocapture: true,
        person_profiles: 'identified_only',
        session_recording: { maskAllInputs: true },
      }),
    );
  });

  it('is idempotent — second call does not re-init', () => {
    stubProductionBuild();
    acceptAnalyticsConsent();
    const cfg = { apiKey: 'phc_test', host: 'https://x', enabled: true };
    initAnalytics(cfg);
    initAnalytics(cfg);
    expect(posthog.init).toHaveBeenCalledTimes(1);
  });
});

describe('track / identify / reset', () => {
  it('does not emit custom events before initialization', () => {
    track('demo', { x: 1 });
    expect(posthog.capture).not.toHaveBeenCalled();
  });

  it('flushes the latest pending identity after consented initialization', () => {
    identify('user-1', { plan: 'free' });
    identify('user-2');
    stubProductionBuild();
    acceptAnalyticsConsent();
    initAnalytics({ apiKey: 'phc_test', host: 'https://x', enabled: true });
    expect(posthog.identify).toHaveBeenCalledTimes(1);
    expect(posthog.identify).toHaveBeenCalledWith('user-2', undefined);
  });

  it('clears a pending identity and applies a reset when reset happens before initialization', () => {
    identify('user-1');
    reset();
    stubProductionBuild();
    acceptAnalyticsConsent();
    initAnalytics({ apiKey: 'phc_test', host: 'https://x', enabled: true });
    expect(posthog.identify).not.toHaveBeenCalled();
    expect(posthog.reset).toHaveBeenCalledOnce();
  });

  it('proxies through to posthog after init', () => {
    stubProductionBuild();
    acceptAnalyticsConsent();
    initAnalytics({ apiKey: 'phc_test', host: 'https://x', enabled: true });
    track('signup', { source: 'invite' });
    identify('user-1', { plan: 'free' });
    reset();
    expect(posthog.capture).toHaveBeenCalledWith('signup', { source: 'invite' });
    expect(posthog.identify).toHaveBeenCalledWith('user-1', { plan: 'free' });
    expect(posthog.reset).toHaveBeenCalled();
  });

  it('opts out, resets, and stops capture when consent is withdrawn', () => {
    stubProductionBuild();
    acceptAnalyticsConsent();
    initAnalytics({ apiKey: 'phc_test', host: 'https://x', enabled: true });

    withdrawAnalyticsConsent();
    track('must_not_send');

    expect(posthog.opt_out_capturing).toHaveBeenCalledOnce();
    expect(posthog.reset).toHaveBeenCalledOnce();
    expect(vi.mocked(posthog.reset).mock.invocationCallOrder[0]).toBeLessThan(
      vi.mocked(posthog.opt_out_capturing).mock.invocationCallOrder[0],
    );
    expect(posthog.capture).not.toHaveBeenCalled();
  });

  it('can initialize again after consent is reaccepted', () => {
    stubProductionBuild();
    acceptAnalyticsConsent();
    const config = { apiKey: 'phc_test', host: 'https://x', enabled: true };
    initAnalytics(config);
    withdrawAnalyticsConsent();
    initAnalytics(config);

    expect(posthog.init).toHaveBeenCalledTimes(2);
    expect(posthog.opt_in_capturing).toHaveBeenCalledWith({ captureEventName: false });
  });
});
