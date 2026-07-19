// ALO-166 / observability: thin PostHog wrapper. The frontend imports
// `track` / `identify` / `reset` from here rather than touching posthog-js
// directly so:
// - Init is idempotent and gated on env vars (no PII goes anywhere if
//   VITE_POSTHOG_KEY is unset).
// - Calls before init or in non-PROD become no-ops instead of throwing.
// - Swapping providers later (Plausible, Mixpanel) is a one-file change.

import posthog, { type PostHog } from 'posthog-js';

let started = false;
let client: PostHog | null = null;

interface PendingIdentity {
  userId: string;
  properties?: Record<string, unknown>;
}

let pendingIdentity: PendingIdentity | null = null;

export interface AnalyticsConfig {
  /** Project API key from app.posthog.com → Project Settings. */
  apiKey: string | undefined;
  /** Cloud (https://us.i.posthog.com) or self-hosted URL. */
  host: string | undefined;
  /** Skip init in dev / when DSN is empty. */
  enabled: boolean;
}

export function readAnalyticsConfig(): AnalyticsConfig {
  const apiKey = import.meta.env.VITE_POSTHOG_KEY as string | undefined;
  const host =
    (import.meta.env.VITE_POSTHOG_HOST as string | undefined) ?? 'https://us.i.posthog.com';
  return {
    apiKey,
    host,
    // Only run in production builds with a real key. Eats the network
    // chatter during local development entirely.
    enabled: Boolean(import.meta.env.PROD && apiKey),
  };
}

function hasAnalyticsConsent(): boolean {
  try {
    const v = window.localStorage.getItem('cookie-consent:v1');
    if (v === 'accepted') return true;
    // Declined or missing: don't start PostHog. The cookie banner calls
    // initAnalytics() directly when the user clicks Accept.
    return false;
  } catch {
    return false;
  }
}

function flushPendingIdentity(): void {
  if (!client || !pendingIdentity) return;
  const { userId, properties } = pendingIdentity;
  pendingIdentity = null;
  client.identify(userId, properties);
}

export function initAnalytics(config: AnalyticsConfig = readAnalyticsConfig()): void {
  if (started || !import.meta.env.PROD || !config.enabled || !config.apiKey) return;
  // Gate on explicit consent. On first visit there is no stored choice yet;
  // the CookieBanner component calls initAnalytics() again on Accept.
  if (!hasAnalyticsConsent()) return;
  posthog.init(config.apiKey, {
    api_host: config.host,
    defaults: '2026-05-30',
    // Capture the standard set automatically; we layer custom events on top
    // via track() below.
    capture_pageview: 'history_change',
    capture_pageleave: true,
    autocapture: true,
    person_profiles: 'identified_only',
    // Mask all input values in session recordings — we do video stuff,
    // people will type private things on the comments/upload pages.
    session_recording: {
      maskAllInputs: true,
    },
    // Respect Do Not Track unless the user explicitly opts in.
    respect_dnt: true,
  });
  client = posthog;
  started = true;
  flushPendingIdentity();
}

// Tag the current visitor as a known user. Safe to call repeatedly with
// the same id (posthog dedupes).
export function identify(userId: string, properties?: Record<string, unknown>): void {
  if (!client) {
    pendingIdentity = { userId, properties };
    return;
  }
  client.identify(userId, properties);
}

export function reset(): void {
  pendingIdentity = null;
  if (!client) return;
  client.reset();
}

export function track(event: string, properties?: Record<string, unknown>): void {
  if (!client) return;
  client.capture(event, properties);
}

// Test seam — reset module-level state between tests so each one gets a
// pristine `started` flag without `posthog.reset()` global side effects.
export function __resetForTests(): void {
  started = false;
  client = null;
  pendingIdentity = null;
}
