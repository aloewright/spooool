// ALO-166 / ALO-184: thin PostHog wrapper. The frontend imports
// `track` / `identify` / `reset` from here rather than touching posthog-js
// directly so:
// - Init is idempotent and gated on env vars (no PII goes anywhere if
//   VITE_POSTHOG_KEY is unset).
// - Calls before init or in non-PROD become no-ops instead of throwing.
// - Swapping providers later (Plausible, Mixpanel) is a one-file change.
// - Privacy defaults are centralised: DNT respected, inputs masked in
//   recordings, and the default ingest host is PostHog EU so anonymous
//   visitor data lands in an EU region by default.

import posthog, { type PostHog } from 'posthog-js';

let started = false;
let client: PostHog | null = null;

export interface AnalyticsConfig {
  /** Project API key from app.posthog.com → Project Settings. */
  apiKey: string | undefined;
  /** Cloud (EU/US) or self-hosted ingest URL. */
  host: string | undefined;
  /** Skip init in dev / when DSN is empty. */
  enabled: boolean;
}

// ALO-184: EU-friendly default. Operators can flip this to
// https://us.i.posthog.com (or any self-hosted URL) by setting
// VITE_POSTHOG_HOST. PostHog's EU cloud is GDPR-compliant out of the box
// and keeps anonymous visitor data inside the EU region.
export const DEFAULT_POSTHOG_HOST = 'https://eu.i.posthog.com';

export function readAnalyticsConfig(): AnalyticsConfig {
  const apiKey = import.meta.env.VITE_POSTHOG_KEY as string | undefined;
  const host =
    (import.meta.env.VITE_POSTHOG_HOST as string | undefined) ?? DEFAULT_POSTHOG_HOST;
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

// `AnalyticsEventName | (string & {})` is the IDE-friendly autocomplete
// trick: the typed union surfaces canonical names in autocomplete and
// catches typos against `ANALYTICS_EVENTS`, while `string & {}` keeps the
// type assignable from any string so ad-hoc/experimental events still
// compile without ceremony.
export function track(
  event: AnalyticsEventName | (string & {}),
  properties?: Record<string, unknown>,
): void {
  if (!client) return;
  client.capture(event, properties);
}

// ALO-184: canonical event names so the funnel dashboard wires up against
// a single source of truth instead of stringly-typed strings sprinkled
// around the codebase. Adding a new event? Add it here first.
export const ANALYTICS_EVENTS = {
  signupCompleted: 'signup_completed',
  uploadStarted: 'upload_started',
  uploadCompleted: 'upload_completed',
  uploadFailed: 'upload_failed',
  videoPlayStarted: 'video_play_started',
  videoFirstWatch: 'video_first_watch',
} as const;

export type AnalyticsEventName =
  (typeof ANALYTICS_EVENTS)[keyof typeof ANALYTICS_EVENTS];

// ALO-184: lightweight first-event detector backed by localStorage so the
// signup → first-upload → first-watch funnel works for both anonymous and
// signed-in users without extra round-trips. The marker survives logout
// (which only resets PostHog's distinct id, not our app storage); a brand
// new browser profile / incognito session is correctly counted as fresh.
const FIRST_EVENT_PREFIX = 'spool.fired.';

export interface FirstEventStorage {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
}

function defaultStorage(): FirstEventStorage | null {
  if (typeof window === 'undefined') return null;
  try {
    return window.localStorage;
  } catch {
    // Safari private mode etc. — fail safe by skipping the marker.
    return null;
  }
}

/**
 * Returns true the first time it's called for a given key, false thereafter.
 * Used to gate "first upload" / "first watch" events — repeated calls with
 * the same key are idempotent. A `storage` override is accepted so unit
 * tests can hand in an in-memory fake.
 */
export function isFirstEvent(
  key: string,
  storage: FirstEventStorage | null = defaultStorage(),
): boolean {
  if (!storage) return false;
  const storageKey = `${FIRST_EVENT_PREFIX}${key}`;
  try {
    if (storage.getItem(storageKey)) return false;
    storage.setItem(storageKey, '1');
    return true;
  } catch {
    return false;
  }
}

// Test seam — reset module-level state between tests so each one gets a
// pristine `started` flag without `posthog.reset()` global side effects.
export function __resetForTests(): void {
  started = false;
  client = null;
}
