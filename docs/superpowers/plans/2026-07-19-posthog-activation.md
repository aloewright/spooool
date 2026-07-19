# PostHog Activation Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Turn Spooool's dormant PostHog scaffolding into an active, privacy-gated production integration with correct SPA pageviews, authenticated-user identity, session replay support, and reproducible Cloudflare build configuration.

**Architecture:** Keep the existing lazy-loaded `posthog-js` adapter so analytics never blocks first paint and the application does not depend on analytics availability. The adapter remains consent-gated and gains current SDK defaults plus an in-memory pending identity, while a tiny React bridge supplies the stable Better Auth user ID on every authenticated app load. Cloudflare's CSP will permit the SDK's ingestion and lazy replay assets, and a tested script will synchronize the public project token from Doppler into every Workers Builds trigger without committing or logging credentials.

**Tech Stack:** TypeScript, React 18, React Router, Better Auth, `posthog-js`, Vitest, Hono security middleware, Doppler CLI, Cloudflare Workers Builds API.

## Global Constraints

- PostHog MUST remain disabled unless `import.meta.env.PROD` is true and `VITE_POSTHOG_KEY` is non-empty.
- PostHog MUST NOT initialize until `cookie-consent:v1` is exactly `accepted`; declined or missing consent sends no analytics.
- The integration MUST continue to lazy-load from `src/frontend/main.tsx`; do not add `@posthog/react` or move PostHog into the eager application bundle.
- SPA pageviews MUST use `capture_pageview: 'history_change'` and current SDK behavior MUST be pinned with `defaults: '2026-05-30'`.
- Session replay MUST use `session_recording: { maskAllInputs: true }` and the application MUST NOT add email, name, passwords, prompts, comments, or other user-authored content as analytics properties.
- Identified users MUST use the stable Better Auth `session.user.id`; logout MUST continue to call `reset()` before navigation.
- Calls made before consent or SDK initialization MUST never throw. Only the latest pending identity may be retained in memory; custom events MUST NOT be queued before consent.
- CSP MUST allow `https://*.posthog.com` in `script-src` and `connect-src`, and MUST define `worker-src 'self' blob: data:` for session replay.
- Doppler MUST remain the source of truth for `VITE_POSTHOG_KEY` and `VITE_POSTHOG_HOST`; no project token, Cloudflare credential, or secret value may be committed or printed.
- Workers Builds synchronization MUST update every trigger attached to the `spooool` Worker and MUST preserve unrelated build environment variables.

---

### Task 1: Make the PostHog adapter SPA-correct and initialization-safe

**Files:**
- Modify: `src/frontend/lib/analytics.ts`
- Modify: `src/frontend/lib/analytics.test.ts`

**Interfaces:**
- Consumes: `posthog-js`'s existing `init`, `capture`, `identify`, and `reset` methods.
- Produces: the existing `initAnalytics`, `identify`, `reset`, and `track` API with pending-identity behavior; no caller signature changes.

- [ ] **Step 1: Write failing tests for current SDK configuration and pending identity**

Add assertions to the successful initialization test:

```ts
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
```

Replace the pre-init proxy test with behavior-specific tests:

```ts
it('does not emit custom events before initialization', () => {
  track('demo', { x: 1 });
  expect(posthog.capture).not.toHaveBeenCalled();
});

it('flushes the latest pending identity after consented initialization', () => {
  identify('user-1', { plan: 'free' });
  identify('user-2');
  acceptAnalyticsConsent();
  initAnalytics({ apiKey: 'phc_test', host: 'https://x', enabled: true });
  expect(posthog.identify).toHaveBeenCalledTimes(1);
  expect(posthog.identify).toHaveBeenCalledWith('user-2', undefined);
});

it('clears a pending identity when reset happens before initialization', () => {
  identify('user-1');
  reset();
  acceptAnalyticsConsent();
  initAnalytics({ apiKey: 'phc_test', host: 'https://x', enabled: true });
  expect(posthog.identify).not.toHaveBeenCalled();
  expect(posthog.reset).not.toHaveBeenCalled();
});
```

- [ ] **Step 2: Run the focused test and verify RED**

Run: `npm test -- --run src/frontend/lib/analytics.test.ts`

Expected: FAIL because the adapter does not pass `defaults`, does not use history-change pageviews, and discards pre-init identity.

- [ ] **Step 3: Implement the current SDK configuration and one-slot identity buffer**

Add module state and a private helper:

```ts
interface PendingIdentity {
  userId: string;
  properties?: Record<string, unknown>;
}

let pendingIdentity: PendingIdentity | null = null;

function flushPendingIdentity(): void {
  if (!client || !pendingIdentity) return;
  const { userId, properties } = pendingIdentity;
  pendingIdentity = null;
  client.identify(userId, properties);
}
```

Initialize PostHog with the exact options below, then assign the client, mark the module started, and flush the pending identity:

```ts
posthog.init(config.apiKey, {
  api_host: config.host,
  defaults: '2026-05-30',
  capture_pageview: 'history_change',
  capture_pageleave: true,
  autocapture: true,
  person_profiles: 'identified_only',
  session_recording: {
    maskAllInputs: true,
  },
  respect_dnt: true,
});
client = posthog;
started = true;
flushPendingIdentity();
```

Update identity and reset behavior without queueing custom events:

```ts
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
```

Set `pendingIdentity = null` in `__resetForTests()`.

- [ ] **Step 4: Verify GREEN and run the complete frontend unit suite once**

Run: `npm test -- --run src/frontend/lib/analytics.test.ts`

Expected: all analytics tests PASS.

Run: `npm test -- --run`

Expected: all root and Workers Vitest suites PASS; the repository's known Happy DOM aborted iframe request and source-map notices may still appear.

- [ ] **Step 5: Commit**

```bash
git add src/frontend/lib/analytics.ts src/frontend/lib/analytics.test.ts
git commit -m "feat: harden PostHog client initialization"
```

---

### Task 2: Identify authenticated sessions on every app load

**Files:**
- Create: `src/frontend/components/AnalyticsIdentity.tsx`
- Create: `src/frontend/components/AnalyticsIdentity.test.tsx`
- Modify: `src/frontend/App.tsx`

**Interfaces:**
- Consumes: `useSession()` from `src/frontend/lib/auth-client.ts` and `identify(userId)` from Task 1.
- Produces: `AnalyticsIdentity(): null`, mounted once inside the application's existing providers.

- [ ] **Step 1: Write a failing component test**

Create a Happy DOM test that mocks the session hook and analytics adapter:

```tsx
// @vitest-environment happy-dom
import { afterEach, describe, expect, it, vi } from 'vitest';
import React, { act } from 'react';
import ReactDOM from 'react-dom/client';

const { identify, useSession } = vi.hoisted(() => ({
  identify: vi.fn(),
  useSession: vi.fn(),
}));

vi.mock('../lib/analytics', () => ({ identify }));
vi.mock('../lib/auth-client', () => ({ useSession }));

import { AnalyticsIdentity } from './AnalyticsIdentity';

describe('AnalyticsIdentity', () => {
  afterEach(() => {
    vi.clearAllMocks();
    document.body.innerHTML = '';
  });

  it('identifies an authenticated session with the stable user id', async () => {
    useSession.mockReturnValue({ data: { user: { id: 'user-42' } }, isPending: false });
    const container = document.createElement('div');
    document.body.append(container);
    const root = ReactDOM.createRoot(container);

    await act(async () => root.render(<AnalyticsIdentity />));

    expect(identify).toHaveBeenCalledOnce();
    expect(identify).toHaveBeenCalledWith('user-42');
    act(() => root.unmount());
  });

  it('does not identify an anonymous session', async () => {
    useSession.mockReturnValue({ data: null, isPending: false });
    const container = document.createElement('div');
    document.body.append(container);
    const root = ReactDOM.createRoot(container);

    await act(async () => root.render(<AnalyticsIdentity />));

    expect(identify).not.toHaveBeenCalled();
    act(() => root.unmount());
  });
});
```

- [ ] **Step 2: Run the focused test and verify RED**

Run: `npm test -- --run src/frontend/components/AnalyticsIdentity.test.tsx`

Expected: FAIL because `AnalyticsIdentity.tsx` does not exist.

- [ ] **Step 3: Implement the lazy identity bridge**

Create the component:

```tsx
import { useEffect } from 'react';
import { useSession } from '../lib/auth-client';

export function AnalyticsIdentity(): null {
  const { data: session } = useSession();
  const userId = session?.user?.id;

  useEffect(() => {
    if (!userId) return;
    void import('../lib/analytics')
      .then(({ identify }) => identify(userId))
      .catch(() => undefined);
  }, [userId]);

  return null;
}
```

Import `AnalyticsIdentity` in `App.tsx` and mount `<AnalyticsIdentity />` once immediately before `<CookieBanner />`. Do not pass email or display-name properties.

- [ ] **Step 4: Verify GREEN and App integration**

Run: `npm test -- --run src/frontend/components/AnalyticsIdentity.test.tsx src/frontend/App.shell.dom.test.tsx`

Expected: component and application-shell tests PASS.

Run: `npm run type-check`

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/frontend/components/AnalyticsIdentity.tsx src/frontend/components/AnalyticsIdentity.test.tsx src/frontend/App.tsx
git commit -m "feat: identify PostHog sessions on app load"
```

---

### Task 3: Allow PostHog ingestion and session replay through CSP

**Files:**
- Modify: `src/workers/security-headers.ts`
- Modify: `src/workers/security-headers.test.ts`

**Interfaces:**
- Consumes: PostHog Cloud origins loaded by the browser SDK.
- Produces: the existing `CSP_HEADER_VALUE` and security middleware with PostHog-compatible directives.

- [ ] **Step 1: Write a failing CSP test**

Add this test:

```ts
it('allows PostHog ingestion and lazy session replay assets', () => {
  expect(CSP_HEADER_VALUE).toContain("script-src 'self' https://challenges.cloudflare.com https://*.posthog.com");
  expect(CSP_HEADER_VALUE).toContain('connect-src');
  expect(CSP_HEADER_VALUE).toContain('https://*.posthog.com');
  expect(CSP_HEADER_VALUE).toContain("worker-src 'self' blob: data:");
});
```

- [ ] **Step 2: Run the focused test and verify RED**

Run: `npm test -- --run src/workers/security-headers.test.ts`

Expected: FAIL because the current CSP permits only ingestion at `https://us.i.posthog.com` and blocks lazy replay scripts/workers.

- [ ] **Step 3: Update the CSP directives**

Use these entries in `CSP_DIRECTIVES`:

```ts
'script-src': [
  "'self'",
  'https://challenges.cloudflare.com',
  'https://*.posthog.com',
],
```

Replace the narrow PostHog entry in `connect-src` with `https://*.posthog.com`, and add:

```ts
'worker-src': ["'self'", 'blob:', 'data:'],
```

Keep every unrelated directive and source unchanged.

- [ ] **Step 4: Verify GREEN**

Run: `npm test -- --run src/workers/security-headers.test.ts`

Expected: all security-header tests PASS.

- [ ] **Step 5: Commit**

```bash
git add src/workers/security-headers.ts src/workers/security-headers.test.ts
git commit -m "fix: permit PostHog assets in browser CSP"
```

---

### Task 4: Make Workers Builds activation reproducible

**Files:**
- Create: `scripts/sync-posthog-build-env.mjs`
- Create: `scripts/sync-posthog-build-env.test.mjs`
- Create: `docs/posthog.md`
- Modify: `package.json`
- Modify: `src/frontend/vite-env.d.ts`

**Interfaces:**
- Consumes: process environment variables `VITE_POSTHOG_KEY`, optional `VITE_POSTHOG_HOST`, `CLOUDFLARE_ACCOUNT_ID`, and either `CLOUDFLARE_API_TOKEN` or the pair `CLOUDFLARE_EMAIL` plus `CLOUDFLARE_API_KEY`.
- Produces: `buildPosthogVariables(env)`, `cloudflareAuthHeaders(env)`, and `syncPosthogBuildEnv({ env, fetchImpl, workerName })`; npm command `posthog:sync-build-env`.

- [ ] **Step 1: Write failing tests for validation, trigger discovery, and non-destructive PATCH payloads**

Create tests covering:

```js
import { describe, expect, it, vi } from 'vitest';
import {
  buildPosthogVariables,
  cloudflareAuthHeaders,
  syncPosthogBuildEnv,
} from './sync-posthog-build-env.mjs';

const configuredEnv = {
  VITE_POSTHOG_KEY: 'phc_test',
  VITE_POSTHOG_HOST: 'https://us.i.posthog.com',
  CLOUDFLARE_ACCOUNT_ID: 'account-1',
  CLOUDFLARE_API_TOKEN: 'cf-token',
};

it('builds only the two PostHog Workers Builds variables', () => {
  expect(buildPosthogVariables(configuredEnv)).toEqual({
    VITE_POSTHOG_KEY: { value: 'phc_test', is_secret: true },
    VITE_POSTHOG_HOST: { value: 'https://us.i.posthog.com', is_secret: false },
  });
});

it('prefers bearer auth and supports legacy user credentials', () => {
  expect(cloudflareAuthHeaders(configuredEnv)).toEqual({ Authorization: 'Bearer cf-token' });
  expect(cloudflareAuthHeaders({
    CLOUDFLARE_EMAIL: 'owner@example.com',
    CLOUDFLARE_API_KEY: 'global-key',
  })).toEqual({ 'X-Auth-Email': 'owner@example.com', 'X-Auth-Key': 'global-key' });
});

it('retries an unauthorized bearer request with available legacy credentials', async () => {
  const fetchImpl = vi.fn()
    .mockResolvedValueOnce(Response.json(
      { success: false, errors: [{ code: 10000, message: 'Authentication error' }] },
      { status: 403 },
    ))
    .mockResolvedValueOnce(Response.json({
      success: true,
      result: [{ id: 'spooool', tag: 'worker-tag' }],
    }))
    .mockResolvedValueOnce(Response.json({ success: true, result: [
      { trigger_uuid: 'production', trigger_name: 'Production' },
    ] }))
    .mockResolvedValueOnce(Response.json({ success: true, result: {} }));

  await syncPosthogBuildEnv({
    env: {
      ...configuredEnv,
      CLOUDFLARE_EMAIL: 'owner@example.com',
      CLOUDFLARE_API_KEY: 'global-key',
    },
    fetchImpl,
    workerName: 'spooool',
  });

  expect(fetchImpl.mock.calls[0][1].headers).toEqual({ Authorization: 'Bearer cf-token' });
  expect(fetchImpl.mock.calls[1][1].headers).toEqual({
    'X-Auth-Email': 'owner@example.com',
    'X-Auth-Key': 'global-key',
  });
});

it('patches every trigger attached to the named worker', async () => {
  const fetchImpl = vi.fn()
    .mockResolvedValueOnce(Response.json({ success: true, result: [{ id: 'spooool', tag: 'worker-tag' }] }))
    .mockResolvedValueOnce(Response.json({ success: true, result: [
      { trigger_uuid: 'preview', trigger_name: 'Preview' },
      { trigger_uuid: 'production', trigger_name: 'Production' },
    ] }))
    .mockResolvedValueOnce(Response.json({ success: true, result: {} }))
    .mockResolvedValueOnce(Response.json({ success: true, result: {} }));

  const result = await syncPosthogBuildEnv({ env: configuredEnv, fetchImpl, workerName: 'spooool' });

  expect(result).toEqual(['Preview', 'Production']);
  expect(fetchImpl).toHaveBeenCalledTimes(4);
  for (const call of fetchImpl.mock.calls.slice(2)) {
    expect(call[1].method).toBe('PATCH');
    expect(JSON.parse(call[1].body)).toEqual(buildPosthogVariables(configuredEnv));
  }
});
```

Also test missing project token, missing Cloudflare account ID, missing credentials, missing Worker, zero triggers, and a Cloudflare `{ success: false, errors }` response.

- [ ] **Step 2: Run the focused test and verify RED**

Run: `npm test -- --run scripts/sync-posthog-build-env.test.mjs`

Expected: FAIL because the synchronization module does not exist.

- [ ] **Step 3: Implement the synchronization module**

The module must:

1. Validate required environment variables without printing their values.
2. Default `VITE_POSTHOG_HOST` to `https://us.i.posthog.com`.
3. Prefer Bearer authentication. When a request returns HTTP 401 or 403 and both legacy credentials are available, retry that request once with Cloudflare email/global-key headers; do not retry other HTTP failures as authentication fallbacks.
4. `GET /accounts/{accountId}/workers/scripts`, find the exact `workerName`, and read its immutable `tag`.
5. `GET /accounts/{accountId}/builds/workers/{tag}/triggers`.
6. `PATCH /accounts/{accountId}/builds/triggers/{trigger_uuid}/environment_variables` once per trigger with only the two PostHog keys. Cloudflare PATCH merges these keys and preserves unrelated variables.
7. Throw an actionable error for a missing Worker, zero triggers, network failure, non-2xx response, or `{ success: false }` response.
8. When invoked directly, print only ``Configured PostHog for Workers Builds trigger: ${trigger.trigger_name}`` after each successful trigger; never print token values or request bodies.

Add this package script:

```json
"posthog:sync-build-env": "node scripts/sync-posthog-build-env.mjs"
```

Add exact Vite environment declarations:

```ts
readonly VITE_POSTHOG_KEY?: string;
readonly VITE_POSTHOG_HOST?: string;
```

- [ ] **Step 4: Document activation and recovery**

Create `docs/posthog.md` documenting:

````markdown
# PostHog

Spooool uses the US PostHog Cloud project. The frontend integration is inert unless a production build receives `VITE_POSTHOG_KEY`, and it starts only after explicit cookie consent.

## Source of truth

Store these in Doppler; never commit them:

- `VITE_POSTHOG_KEY` — PostHog project token (`phc_…`)
- `VITE_POSTHOG_HOST` — `https://us.i.posthog.com`

## Synchronize Cloudflare Workers Builds

Workers Builds needs build-time variables because Vite bakes `VITE_*` values into static assets:

```bash
doppler run --project quickapp --config dev -- npm run posthog:sync-build-env
```

The command updates both preview and production triggers without replacing unrelated variables. Re-run it after recreating a Workers Builds trigger or rotating the project token.

## Verification

1. Build production assets with Doppler and confirm the analytics chunk contains the configured host but never log the token.
2. Deploy through the `main` Workers Builds trigger.
3. Open Spooool in a clean browser profile, accept analytics cookies, and navigate between two SPA routes.
4. Confirm `$pageview` events and the stable Better Auth user ID appear in PostHog Live Events.
5. Confirm declining analytics cookies produces no PostHog ingestion requests.
````

- [ ] **Step 5: Verify GREEN, types, lint, and build**

Run: `npm test -- --run scripts/sync-posthog-build-env.test.mjs`

Expected: all synchronization tests PASS.

Run: `npm run type-check && npm run lint && npm run build`

Expected: all commands PASS; lint may retain the repository's pre-existing warning baseline but must report zero errors.

- [ ] **Step 6: Store the connected project configuration in Doppler**

Retrieve the active PostHog project's `api_token` through the authenticated PostHog projects connector. In the same orchestration call, pass that in-memory value directly to `doppler secrets set --project quickapp --config dev --silent` as `VITE_POSTHOG_KEY`, together with `VITE_POSTHOG_HOST=https://us.i.posthog.com`. Do not print the connector response, generated command, token, or Doppler values. The token must never enter a tracked file, task report, or test fixture other than the literal `phc_test` fixture.

- [ ] **Step 7: Synchronize and verify every Workers Builds trigger**

Run:

```bash
doppler run --project quickapp --config dev -- npm run posthog:sync-build-env
```

Expected: one success line for `Deploy non-production branches` and one for `Deploy default branch`, with no values printed.

Use Doppler names-only output to confirm both keys exist. Use the Cloudflare Builds API to confirm both trigger environment-variable maps contain `VITE_POSTHOG_KEY` as a secret and `VITE_POSTHOG_HOST` as plaintext, checking key names and flags only. Append only command names, exit statuses, trigger names, and value-redacted verification to the task report.

- [ ] **Step 8: Commit**

```bash
git add scripts/sync-posthog-build-env.mjs scripts/sync-posthog-build-env.test.mjs docs/posthog.md package.json src/frontend/vite-env.d.ts
git commit -m "feat: automate PostHog build activation"
```
