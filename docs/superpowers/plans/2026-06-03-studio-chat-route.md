# AI Studio Chat Route (`studio.ts`) Implementation Plan — ALO-644

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development. Steps use checkbox (`- [ ]`) syntax.

**Goal:** Add `src/workers/studio.ts` — a Hono router exposing `POST /api/studio/chat` that streams an `@tanstack/ai` chat response as Server-Sent Events, gated by auth + email-verification + a new `STUDIO_GEN_BUCKET` rate limit; mount it in `index.ts`.

**Architecture:** Mirrors `src/workers/create.ts` (auth/email/rate-limit gates, Hono sub-router mounted via `app.route('/', studioRoutes)`). The handler validates the client's user/assistant messages, prepends a server-controlled system prompt, calls `chat({ adapter: gatewayChat(c.env …), systemPrompts, messages })` from ALO-642's `ai-gateway.ts`, and returns `toServerSentEventsResponse(stream)`. Transport mode (run-gateway default) is owned by `ai-gateway.ts` — the route is mode-agnostic.

**Tech Stack:** TypeScript · Hono · Cloudflare Workers · `@tanstack/ai` (`chat`, `toServerSentEventsResponse`) + `src/workers/ai-gateway.ts` (`gatewayChat`) · zod · vitest (node env).

**Depends on:** ALO-642 (`ai-gateway.ts`). This branch (`alo-644-studio-chat-route`) is off `alo-642-ai-gateway-transport`; it does NOT depend on ALO-643.

---

## Context an engineer needs
- **Mirror `src/workers/create.ts`:** `export const createRoutes = new Hono<{ Bindings: CreateEnv; Variables: { user: SessionUser | null } }>()`. Each handler: `const user = c.get('user'); if (!user) return c.json({error:'Unauthorized'},401); if (!user.emailVerified) return c.json({error:'Email verification required'},403);` then `const rl = await rateLimit({ ns: c.env.RATE_LIMITER, bucket: BUCKET, identity: user.id }); if (!rl.allowed) return c.json({error:'…'},429, rateLimitHeaders(rl));`.
- **Auth/user var:** `index.ts`'s `/api/*` middleware calls `auth.api.getSession` and `c.set('user', sessionUser)` where `SessionUser = { id; email; name; emailVerified }`. The router reads it via `c.get('user')`. Tests must inject this var (see Task 1 test).
- **Mounting:** `index.ts` mounts sub-routers with `app.route('/', xRoutes)` (lines ~146-173), after the auth middleware. Add `app.route('/', studioRoutes)` near `createRoutes` (line ~164). Import `studioRoutes` + `type StudioEnv`; fold `StudioEnv` into the `EnvBindings` intersection (it's a subset of what `EnvBindings` already provides — `AI`, `RATE_LIMITER`, `AI_GATEWAY_MODE` — so this is additive and safe).
- **Env type:** `gatewayChat` takes `AiGatewayEnv` (from `ai-gateway.ts`). `EnvBindings`/`StudioEnv` carry the create-tools-style `AIBindingEnv.AI` whose gateway return type differs at the tsc level (`Promise<unknown>` vs `Promise<Response>`). Use the SAME localized cast the codebase uses: `gatewayChat(c.env as unknown as AiGatewayEnv)`. Comment it (point at the create-tools precedent).
- **`@tanstack/ai` chat:** `chat({ adapter, messages, systemPrompts? })` returns an `AsyncIterable<StreamChunk>` (streaming by default — do NOT pass `stream:false`). `chat()` REJECTS `role:'system'` in `messages` — system content goes in `systemPrompts`. `toServerSentEventsResponse(stream)` → a `Response` with `Content-Type: text/event-stream` that serializes each chunk as `data: <json>\n\n` and ends on `RUN_FINISHED`.
- **Rate-limit pattern:** `src/workers/rate-limit.ts` exports `RateLimitBucket`, `rateLimit`, `rateLimitHeaders`, and buckets like `CREATE_BUCKET = { name:'create', capacity:5, refillPerSecond:5/3600 }`.
- **Lint:** `check-no-direct-providers.mjs` allows `@tanstack/ai` + `@cf/*`; no provider SDKs. Stays green.

## File Structure
| File | Change |
|---|---|
| `src/workers/rate-limit.ts` | add `STUDIO_GEN_BUCKET` |
| `src/workers/studio.ts` | **new** — `studioRoutes` + `StudioEnv` + `POST /api/studio/chat` |
| `src/workers/studio.test.ts` | **new** — 401/403/429 + SSE happy-path |
| `src/workers/index.ts` | import + `app.route('/', studioRoutes)` + fold `StudioEnv` into `EnvBindings` |

---

### Task 1: `STUDIO_GEN_BUCKET` + `studio.ts` chat route + mount + tests

**Files:** modify `rate-limit.ts`; create `studio.ts` + `studio.test.ts`; modify `index.ts`.

- [ ] **Step 1: Add the rate-limit bucket**
In `src/workers/rate-limit.ts`, next to `CREATE_BUCKET`:
```ts
// 30 studio generations per hour per user (placeholder — tuned per Polar tier
// in ALO-650). Shared across AI Studio ops; chat is the first consumer.
export const STUDIO_GEN_BUCKET: RateLimitBucket = {
  name: 'studio-gen',
  capacity: 30,
  refillPerSecond: 30 / 3600,
};
```

- [ ] **Step 2: Write the failing test `src/workers/studio.test.ts`**
Mock `@tanstack/ai` so `chat` returns a small async-iterable of AG-UI chunks, and build a Hono harness that sets `c.set('user', …)` before mounting `studioRoutes` (so the route sees a user). Test 401 (no user), 403 (unverified), 429 (rate-limited), and SSE happy path.
```ts
import { describe, expect, it, vi, beforeEach } from 'vitest';
import { Hono } from 'hono';

vi.mock('@tanstack/ai', async (orig) => {
  const actual = await orig<typeof import('@tanstack/ai')>();
  return {
    ...actual,
    chat: vi.fn(() => (async function* () {
      yield { type: 'RUN_STARTED', runId: 'r1' };
      yield { type: 'TEXT_MESSAGE_CONTENT', messageId: 'm1', delta: 'hi there' };
      yield { type: 'RUN_FINISHED', runId: 'r1' };
    })()),
  };
});

import { studioRoutes } from './studio';

type U = { id: string; email: string; name: string; emailVerified: boolean } | null;
function harness(user: U, env: Record<string, unknown> = {}) {
  const app = new Hono();
  app.use('*', async (c, next) => { c.set('user', user); await next(); });
  app.route('/', studioRoutes);
  const base = { AI: { gateway: () => ({ run: async () => new Response('') }), run: async () => ({}) }, ...env };
  return (body: unknown) => app.request('/api/studio/chat', {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body),
  }, base);
}
const okBody = { messages: [{ role: 'user', content: 'help me name my video' }] };

describe('POST /api/studio/chat', () => {
  beforeEach(() => vi.clearAllMocks());
  it('401 when unauthenticated', async () => {
    expect((await harness(null)(okBody)).status).toBe(401);
  });
  it('403 when email not verified', async () => {
    const r = await harness({ id: 'u1', email: 'a@b.c', name: 'A', emailVerified: false })(okBody);
    expect(r.status).toBe(403);
  });
  it('streams SSE for a verified user', async () => {
    const r = await harness({ id: 'u1', email: 'a@b.c', name: 'A', emailVerified: true })(okBody);
    expect(r.status).toBe(200);
    expect(r.headers.get('content-type')).toMatch(/text\/event-stream/);
    const text = await r.text();
    expect(text).toContain('data:');
    expect(text).toContain('hi there');
  });
  it('400 on invalid body (no messages)', async () => {
    const r = await harness({ id: 'u1', email: 'a@b.c', name: 'A', emailVerified: true })({});
    expect(r.status).toBe(400);
  });
});
```
Run `npx vitest run src/workers/studio.test.ts` → FAIL (module missing).

- [ ] **Step 3: Implement `src/workers/studio.ts`**
```ts
// AI Studio routes (E11). POST /api/studio/chat streams an @tanstack/ai chat
// response as SSE. Model selection + system prompt are server-controlled;
// the client only sends the user/assistant turns. All generation is gateway-
// routed via ai-gateway.ts (transport mode owned there; default run-gateway).
import { Hono } from 'hono';
import { z } from 'zod';
import { chat, toServerSentEventsResponse } from '@tanstack/ai';
import { gatewayChat, type AiGatewayEnv, type AiGatewayMode } from './ai-gateway';
import type { AIBindingEnv } from './create-tools';
import { STUDIO_GEN_BUCKET, rateLimit, rateLimitHeaders } from './rate-limit';

export interface StudioEnv extends AIBindingEnv {
  RATE_LIMITER?: DurableObjectNamespace;
  AI_GATEWAY_MODE?: AiGatewayMode;
}

interface SessionUser { id: string; emailVerified: boolean }
type StudioVariables = { user: SessionUser | null };

const STUDIO_SYSTEM_PROMPT =
  "You are spooool's creative studio assistant. Help creators brainstorm video ideas, " +
  'scripts, titles, descriptions, and thumbnails. Be concise and practical.';

const chatBodySchema = z.object({
  messages: z.array(z.object({
    role: z.enum(['user', 'assistant']),
    content: z.string().min(1).max(8000),
  })).min(1).max(50),
});

export const studioRoutes = new Hono<{ Bindings: StudioEnv; Variables: StudioVariables }>();

studioRoutes.post('/api/studio/chat', async (c) => {
  const user = c.get('user');
  if (!user) return c.json({ error: 'Unauthorized' }, 401);
  if (!user.emailVerified) return c.json({ error: 'Email verification required' }, 403);

  const rl = await rateLimit({ ns: c.env.RATE_LIMITER, bucket: STUDIO_GEN_BUCKET, identity: user.id });
  if (!rl.allowed) return c.json({ error: 'Too many studio requests. Try again shortly.' }, 429, rateLimitHeaders(rl));

  const raw = await c.req.json().catch(() => null);
  const parsed = chatBodySchema.safeParse(raw);
  if (!parsed.success) return c.json({ error: 'Invalid body', details: parsed.error.flatten() }, 400);

  // Cast: AIBindingEnv.AI.gateway returns Promise<unknown> while AiGatewayEnv's
  // CloudflareAiGateway.run returns Promise<Response> — a tsc-only divergence
  // bridged at runtime by the real Ai binding. Same pattern as create-tools.ts.
  const stream = chat({
    adapter: gatewayChat(c.env as unknown as AiGatewayEnv),
    systemPrompts: [STUDIO_SYSTEM_PROMPT],
    messages: parsed.data.messages,
  });
  return toServerSentEventsResponse(stream);
});
```

- [ ] **Step 4: Mount in `index.ts`**
Add the import (near the `createRoutes` import): `import { studioRoutes, type StudioEnv } from './studio';`. Add `& StudioEnv` to the `EnvBindings` intersection (next to `& CreateEnv`). Add `app.route('/', studioRoutes);` next to `app.route('/', createRoutes);`.

- [ ] **Step 5: Run gates**
`npx vitest run src/workers/studio.test.ts` (4 pass), `npm run type-check` (whole repo, exit 0), `npm run lint:no-providers` (0 findings), `npm run lint` (0 errors).

- [ ] **Step 6: Commit**
```bash
git add src/workers/studio.ts src/workers/studio.test.ts src/workers/rate-limit.ts src/workers/index.ts
git commit -m "feat(studio): add POST /api/studio/chat SSE route + STUDIO_GEN_BUCKET"
```

---

### Task 2: Full verification
- [ ] **Step 1:** `npm run type-check && npx vitest run src/workers/studio.test.ts src/workers/rate-limit.test.ts && npm run lint:no-providers && npm run build` — all green. If `rate-limit.test.ts` enumerates buckets, update it for `STUDIO_GEN_BUCKET`.
- [ ] **Step 2:** Confirm `app.route('/', studioRoutes)` is present and `EnvBindings` includes `StudioEnv` (type-check proves wiring).

## Acceptance criteria (ALO-644) → task mapping
- [ ] `POST /api/studio/chat` streams SSE via `toServerSentEventsResponse` — Task 1.
- [ ] 401 unauth, 403 unverified, 429 rate-limited — Task 1 (tests).
- [ ] `studioRoutes` mounted in `index.ts`; `StudioEnv` folded into `EnvBindings` — Task 1.
- [ ] Unit test asserts SSE content-type + a mocked stream is forwarded — Task 1.

## Notes
- No tools / no image-video here (those are ALO-646/647). System prompt + model are server-controlled; the client `model` field (if any) is ignored.
- In the default run-gateway mode the underlying `env.AI.run` returns the full text, so the SSE stream delivers one `TEXT_MESSAGE_CONTENT` event rather than token-by-token; gateway-binding mode streams incrementally. Both are valid SSE; the `useChat` client (ALO-645) renders either.
