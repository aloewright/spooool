// ALO-166 / observability: thin PostHog wrapper. The frontend imports
// `track` / `identify` / `reset` from here rather than touching posthog-js
// directly so:
// - Init is idempotent and gated on env vars (no PII goes anywhere if
//   VITE_POSTHOG_KEY is unset).
// - Calls before init or in non-PROD become no-ops instead of throwing.
// - Swapping providers later (Plausible, Mixpanel) is a one-file change.
//
// ALO-179: callers must also satisfy the consent gate before init runs.
// `initAnalyticsIfAllowed` skips init when the visitor has explicitly
// rejected analytics cookies. The EU consent banner persists that choice
// in localStorage; non-EU visitors default to the legacy DNT-respecting
// behaviour, which is preserved.

import posthog, { type PostHog } from 'posthog-js';
import { hasFreshAcceptedConsent, readConsent } from './legal';

let started = false;
let client: PostHog | null = null;

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

export function initAnalytics(config: AnalyticsConfig = readAnalyticsConfig()): void {
  if (started || !config.enabled || !config.apiKey) return;
  posthog.init(config.apiKey, {
    api_host: config.host,
    // Capture the standard set automatically; we layer custom events on top
    // via track() below.
    capture_pageview: true,
    capture_pageleave: true,
    autocapture: true,
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
}

// Tag the current visitor as a known user. Safe to call repeatedly with
// the same id (posthog dedupes).
export function identify(userId: string, properties?: Record<string, unknown>): void {
  if (!client) return;
  client.identify(userId, properties);
}

export function reset(): void {
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
}

// ALO-179: pure consent-gate predicate. Allowed only when there is no
// record (legacy behaviour: respect DNT inside posthog) or when the
// visitor has freshly accepted against the current cookie-policy version.
// Rejected and stale records both block — material policy changes require
// fresh consent under GDPR.
export function isAnalyticsAllowedFor(record: import('./legal').ConsentRecord | null): boolean {
  if (record === null) return true;
  if (record.choice === 'rejected') return false;
  return hasFreshAcceptedConsent(record);
}

// Convenience wrapper: reads the current consent record from
// localStorage and applies the gate.
export function isAnalyticsAllowed(): boolean {
  return isAnalyticsAllowedFor(readConsent());
}

// ALO-179: gated init used by the bootstrap path (main.tsx) and by the
// cookie banner's onAccept callback. Returns whether init actually ran so
// callers can chain identify() etc. only after a real start.
export function initAnalyticsIfAllowed(config: AnalyticsConfig = readAnalyticsConfig()): boolean {
  if (!isAnalyticsAllowed()) return false;
  initAnalytics(config);
  return started;
}
