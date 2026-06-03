# AI-Gateway Transport (`ai-gateway.ts`) Implementation Plan — ALO-642

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add `@tanstack/ai` to spooool and build `src/workers/ai-gateway.ts` — the single, gateway-routed transport that every generation activity (chat, image, TTS, transcription, summarize) goes through, preserving AI-Gateway observability/caching and keeping `lint:no-providers` green.

**Architecture:** A small module of named factory functions (`gatewayChat`, `gatewayImage`, `gatewayTts`, `gatewayTranscription`, `gatewaySummarize`) that each return a `@tanstack/ai` *adapter*. The default `gateway-binding` mode builds adapters from `@cloudflare/tanstack-ai` with `{ binding: env.AI.gateway('x') }` (routes through the gateway, observability preserved). A second `run-gateway` mode (selected by the `AI_GATEWAY_MODE` var) provides a custom chat/TTS adapter that calls `env.AI.run('@cf/<model>', input, { gateway: { id: 'x' } })` directly — byte-for-byte parity with today's `create-tools.ts` — as a de-risking fallback if `env.AI.gateway('x')` misbehaves for any activity on this account. Plain `{ binding: env.AI }` is never used (it drops `cf-aig` observability).

**Tech Stack:** TypeScript · Cloudflare Workers (`env.AI` Workers AI binding + AI Gateway `x`) · `@tanstack/ai` + `@cloudflare/tanstack-ai` + `@tanstack/ai-react` · vitest (node env) · Hono worker (`src/workers/index.ts`).

**Spec:** `docs/superpowers/specs/2026-06-02-native-editing-ai-studio-design.md` (E11 AI Studio). This plan is E11's foundation task; ALO-643/644/646/647/648/649 all depend on it.

---

## Context an engineer needs before starting

- **The AI-Gateway-only rule** lives in `/Users/aloe/.claude/CLAUDE.md`. Inside a Worker, `dynamic/*` gateway routes are broken on all three call paths; the only proven Worker-side invocation is `env.AI.run('@cf/<concrete-model>', input, { gateway: { id: 'x' } })`. The gateway id on this account is **`'x'`** (see `src/workers/create-tools.ts`, which already uses it — the `[ai]` comment in `wrangler.toml` historically said `'spooool'`, but `'x'` is the live value).
- **`scripts/check-no-direct-providers.mjs`** (run via `npm run lint:no-providers`, part of `npm run lint`) fails CI if any non-test file under `src/`, `scripts/`, `tests/` imports a provider SDK (`openai`, `@anthropic-ai/sdk`, `@ai-sdk/*`, `replicate`, `@fal-ai/*`, `cohere-ai`, `groq-sdk`, `@google/generative-ai`), hits a provider URL, or hardcodes a model id matching `openai/gpt-*`, `anthropic/claude-*`, or `google/gemini-*`. It does **not** forbid `@tanstack/ai`, `@cloudflare/tanstack-ai`, or `@cf/*` model ids — so this module is compliant by construction. Verify it stays green at the end (Task 6).
- **The existing AI call site** is `src/workers/create-tools.ts`: `env.AI.run('@cf/google/gemma-4-26b-a4b-it', { messages, max_tokens: 800 }, { gateway: { id: 'x' } })` for chat, `env.AI.run('@cf/deepgram/aura-2-en', { text, speaker, encoding: 'mp3' }, { gateway: { id: 'x' } })` for TTS. It exports `interface AIBindingEnv { AI: { gateway: (slug: string) => …; run: (model, input, opts?) => … } }` — reuse it as the base env type. ALO-643 migrates create-tools onto this module next; do not modify create-tools in this task.
- **Worker env typing + router mounting** is in `src/workers/index.ts`: `type EnvBindings = AuthEnv & VideoRoutesEnv & RenderEnv & CreateEnv & StreamUploadEnv & { … }`. The new `AI_GATEWAY_MODE` var is added to this intersection in Task 5.
- **Tests** run under vitest (`vitest.config.ts` includes `src/**/*.{test,spec}.{ts,tsx}`), default **node** environment (no DOM needed here). Mock the `env.AI` binding; never hit a real model in unit tests.
- **Default models** (pin these as named constants; Appendix-B open questions track which to confirm before launch):
  - chat `@cf/google/gemma-4-26b-a4b-it` (verified present; kept for create-tools output parity)
  - image `@cf/stabilityai/stable-diffusion-xl-base-1.0` (the `@cloudflare/tanstack-ai` doc example; confirm vs a flux id later)
  - tts `@cf/deepgram/aura-2-en` (from create-tools)
  - stt `@cf/openai/whisper-large-v3-turbo` (confirm current; note `@cf/openai/whisper-*` is NOT matched by the lint guard's `openai/gpt-*` rule)
  - summarize `@cf/facebook/bart-large-cnn`

## File Structure

| File | Responsibility |
|---|---|
| `package.json` | add `@tanstack/ai`, `@cloudflare/tanstack-ai`, `@tanstack/ai-react` deps |
| `src/workers/ai-gateway.ts` | **new** — `GATEWAY_ID`, `AiGatewayMode`, `AiGatewayEnv`, `DEFAULT_*_MODEL`, `resolveMode`, and the five `gateway*` factory functions + the `run-gateway` custom chat/TTS adapters |
| `src/workers/ai-gateway.test.ts` | **new** — unit tests asserting gateway routing in both modes; no real model calls |
| `src/workers/index.ts` | modify — add `AI_GATEWAY_MODE` to `EnvBindings` |
| `wrangler.toml` | modify — add `AI_GATEWAY_MODE = "gateway-binding"` under `[vars]` |

Each `gateway*` factory is one focused export. The module stays the single import surface for all AI activities, so the provider-guard's blast radius is one file.

---

### Task 1: Install deps + pin the SDK API (verification spike)

The `@cloudflare/tanstack-ai` factory signatures are documented, but the provider-side `ChatAdapter`/`TTSAdapter` interfaces consumed by the `run-gateway` custom adapter (Task 5) are not fully public. Pin them from the installed types before writing code against them. This spike also resolves spec Appendix-B open questions 1, 2, and 6.

**Files:**
- Modify: `package.json` (dependencies)

- [ ] **Step 1: Install the three packages**

```bash
cd /Users/aloe/Development/spooool
npm install @tanstack/ai @cloudflare/tanstack-ai @tanstack/ai-react
```

Expected: `package.json` gains the three deps; `package-lock.json` updates; install exits 0.

- [ ] **Step 2: Confirm the exported factory names exist**

```bash
node -e "const m=require('@cloudflare/tanstack-ai'); console.log(Object.keys(m).filter(k=>/^createWorkersAi/.test(k)).sort())"
```

Expected: includes `createWorkersAiChat`, `createWorkersAiImage`, `createWorkersAiTts`, `createWorkersAiTranscription`, `createWorkersAiSummarize`. If a name differs (e.g. `createWorkersAiTTS`), record the real name — every later task must use it.

- [ ] **Step 3: Read the provider-adapter type declarations and record them**

```bash
ls node_modules/@tanstack/ai/dist
grep -rn "interface ChatAdapter" node_modules/@tanstack/ai/dist || grep -rln "ChatAdapter" node_modules/@tanstack/ai/dist
grep -rn "interface TTSAdapter\|type TTSAdapter\|kind: \"tts\"\|kind: 'tts'" node_modules/@tanstack/ai/dist
grep -rn "interface StreamChunk\|type StreamChunk" node_modules/@tanstack/ai/dist
grep -rn "function generateSpeech\|function generateImage\|function chat" node_modules/@tanstack/ai/dist
```

Read the matched `.d.ts` files. **Record, in a scratch note you will paste into the `ai-gateway.ts` header comment in Task 2:**
- the exact `ChatAdapter` interface (its `kind` discriminator + the method that produces the stream, with its parameter and return types)
- the exact `TTSAdapter` interface (its `kind` + its generate method + the result shape — confirm audio is returned as base64 in `result.audio`)
- the `StreamChunk` union shape (the variant used for a plain text delta)
- the `generateSpeech` / `generateImage` / `chat` signatures

Expected: concrete interfaces captured. These are the ground truth for Task 5's custom adapter; if they differ from the best-effort code in Task 5, conform to what you recorded here.

- [ ] **Step 4: Commit the dependency addition**

```bash
git checkout -b alo-642-ai-gateway-transport
git add package.json package-lock.json
git commit -m "build(ai): add @tanstack/ai, @cloudflare/tanstack-ai, @tanstack/ai-react deps"
```

---

### Task 2: `ai-gateway.ts` core — constants, types, mode resolver, gateway-binding chat factory

**Files:**
- Create: `src/workers/ai-gateway.ts`
- Test: `src/workers/ai-gateway.test.ts`

- [ ] **Step 1: Write the failing test**

```ts
// src/workers/ai-gateway.test.ts
import { describe, expect, it, vi, beforeEach } from 'vitest';

// Mock the Cloudflare adapter package so we can assert how our factories
// construct adapters without importing the real SDK runtime.
vi.mock('@cloudflare/tanstack-ai', () => ({
  createWorkersAiChat: vi.fn((model, config) => ({ kind: 'chat', model, config })),
  createWorkersAiImage: vi.fn((model, config) => ({ kind: 'image', model, config })),
  createWorkersAiTts: vi.fn((model, config) => ({ kind: 'tts', model, config })),
  createWorkersAiTranscription: vi.fn((model, config) => ({ kind: 'transcription', model, config })),
  createWorkersAiSummarize: vi.fn((model, config) => ({ kind: 'summarize', model, config })),
}));

import { createWorkersAiChat } from '@cloudflare/tanstack-ai';
import { gatewayChat, GATEWAY_ID, DEFAULT_CHAT_MODEL, resolveMode } from './ai-gateway';

function makeEnv(overrides = {}) {
  const gatewaySentinel = { __gateway: true };
  return {
    AI: {
      gateway: vi.fn(() => gatewaySentinel),
      run: vi.fn(),
    },
    ...overrides,
  } as any;
}

describe('ai-gateway gateway-binding mode', () => {
  beforeEach(() => vi.clearAllMocks());

  it('defaults to gateway-binding mode', () => {
    expect(resolveMode(makeEnv())).toBe('gateway-binding');
  });

  it('gatewayChat builds the adapter against env.AI.gateway(GATEWAY_ID), not plain env.AI', () => {
    const env = makeEnv();
    gatewayChat(env);
    expect(env.AI.gateway).toHaveBeenCalledWith(GATEWAY_ID);
    expect(createWorkersAiChat).toHaveBeenCalledWith(
      DEFAULT_CHAT_MODEL,
      { binding: env.AI.gateway(GATEWAY_ID) },
    );
    // observability guard: never plain { binding: env.AI }
    const [, config] = (createWorkersAiChat as any).mock.calls[0];
    expect(config.binding).not.toBe(env.AI);
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx vitest run src/workers/ai-gateway.test.ts`
Expected: FAIL — `Cannot find module './ai-gateway'`.

- [ ] **Step 3: Write the minimal implementation**

```ts
// src/workers/ai-gateway.ts
//
// Single entry point for all @tanstack/ai generation activities in spooool.
// Every factory returns a @tanstack/ai adapter that is GATEWAY-ROUTED so AI
// Gateway observability + caching + cost analytics are preserved — the same
// guarantee create-tools.ts gets today from
//   env.AI.run('@cf/..', input, { gateway: { id: 'x' } }).
//
// WHY NOT plain { binding: env.AI }: @cloudflare/tanstack-ai's plain-binding
// mode calls binding.run(model, inputs, { extraHeaders, signal }) with NO
// gateway option, dropping all cf-aig observability. We default to the AI
// Gateway *binding* mode: { binding: env.AI.gateway('x') }.
//
// Worker quirk (why concrete @cf/<model> ids, not dynamic/* slugs): see
// /Users/aloe/.claude/CLAUDE.md "Inside a Worker".
//
// >>> PASTE the ChatAdapter / TTSAdapter / StreamChunk interfaces recorded in
// >>> Task 1 Step 3 here, so Task 5's custom adapter is written against fact.

import { createWorkersAiChat } from '@cloudflare/tanstack-ai';
import type { AIBindingEnv } from './create-tools';

/** AI Gateway id for this account. NOT 'spooool' — see create-tools.ts. */
export const GATEWAY_ID = 'x';

export type AiGatewayMode = 'gateway-binding' | 'run-gateway';

export interface AiGatewayEnv extends AIBindingEnv {
  /** Defaults to 'gateway-binding'. Set to 'run-gateway' only if the gateway
   *  binding misbehaves for an activity on this account (see Task 5). */
  AI_GATEWAY_MODE?: AiGatewayMode;
}

export const DEFAULT_CHAT_MODEL = '@cf/google/gemma-4-26b-a4b-it';
export const DEFAULT_IMAGE_MODEL = '@cf/stabilityai/stable-diffusion-xl-base-1.0';
export const DEFAULT_TTS_MODEL = '@cf/deepgram/aura-2-en';
export const DEFAULT_STT_MODEL = '@cf/openai/whisper-large-v3-turbo';
export const DEFAULT_SUMMARIZE_MODEL = '@cf/facebook/bart-large-cnn';

export function resolveMode(env: AiGatewayEnv): AiGatewayMode {
  return env.AI_GATEWAY_MODE === 'run-gateway' ? 'run-gateway' : 'gateway-binding';
}

/** The AI Gateway binding. Routing + cf-aig observability happen here. */
function gatewayBinding(env: AiGatewayEnv) {
  return env.AI.gateway(GATEWAY_ID);
}

export function gatewayChat(env: AiGatewayEnv, model: string = DEFAULT_CHAT_MODEL) {
  return createWorkersAiChat(model, { binding: gatewayBinding(env) });
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `npx vitest run src/workers/ai-gateway.test.ts`
Expected: PASS (3 assertions).

- [ ] **Step 5: Commit**

```bash
git add src/workers/ai-gateway.ts src/workers/ai-gateway.test.ts
git commit -m "feat(ai): add ai-gateway transport core + gateway-routed chat factory"
```

---

### Task 3: Remaining gateway-binding factories (image, tts, transcription, summarize)

**Files:**
- Modify: `src/workers/ai-gateway.ts`
- Test: `src/workers/ai-gateway.test.ts`

- [ ] **Step 1: Add the failing tests**

Append to `src/workers/ai-gateway.test.ts`:

```ts
import {
  gatewayImage, gatewayTts, gatewayTranscription, gatewaySummarize,
  DEFAULT_IMAGE_MODEL, DEFAULT_TTS_MODEL, DEFAULT_STT_MODEL, DEFAULT_SUMMARIZE_MODEL,
} from './ai-gateway';
import {
  createWorkersAiImage, createWorkersAiTts,
  createWorkersAiTranscription, createWorkersAiSummarize,
} from '@cloudflare/tanstack-ai';

describe('ai-gateway: every activity is gateway-routed', () => {
  beforeEach(() => vi.clearAllMocks());

  it.each([
    ['image', () => gatewayImage(makeEnv()), createWorkersAiImage, DEFAULT_IMAGE_MODEL],
    ['tts', () => gatewayTts(makeEnv()), createWorkersAiTts, DEFAULT_TTS_MODEL],
    ['transcription', () => gatewayTranscription(makeEnv()), createWorkersAiTranscription, DEFAULT_STT_MODEL],
    ['summarize', () => gatewaySummarize(makeEnv()), createWorkersAiSummarize, DEFAULT_SUMMARIZE_MODEL],
  ])('gateway%s routes through env.AI.gateway(GATEWAY_ID)', (_label, call, factory, model) => {
    call();
    const lastCall = (factory as any).mock.calls.at(-1);
    expect(lastCall[0]).toBe(model);
    expect(lastCall[1].binding).not.toBe(undefined);
    // gateway binding sentinel, never the plain AI binding
    expect(lastCall[1].binding).toEqual({ __gateway: true });
  });
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `npx vitest run src/workers/ai-gateway.test.ts`
Expected: FAIL — `gatewayImage is not a function` (not yet exported).

- [ ] **Step 3: Implement the four factories**

Add to `src/workers/ai-gateway.ts` (extend the import + append factories):

```ts
import {
  createWorkersAiChat,
  createWorkersAiImage,
  createWorkersAiTts,
  createWorkersAiTranscription,
  createWorkersAiSummarize,
} from '@cloudflare/tanstack-ai';
```

```ts
export function gatewayImage(env: AiGatewayEnv, model: string = DEFAULT_IMAGE_MODEL) {
  return createWorkersAiImage(model, { binding: gatewayBinding(env) });
}

export function gatewayTts(env: AiGatewayEnv, model: string = DEFAULT_TTS_MODEL) {
  return createWorkersAiTts(model, { binding: gatewayBinding(env) });
}

export function gatewayTranscription(env: AiGatewayEnv, model: string = DEFAULT_STT_MODEL) {
  return createWorkersAiTranscription(model, { binding: gatewayBinding(env) });
}

export function gatewaySummarize(env: AiGatewayEnv, model: string = DEFAULT_SUMMARIZE_MODEL) {
  return createWorkersAiSummarize(model, { binding: gatewayBinding(env) });
}
```

- [ ] **Step 4: Run to verify it passes**

Run: `npx vitest run src/workers/ai-gateway.test.ts`
Expected: PASS (all activity cases green).

- [ ] **Step 5: Commit**

```bash
git add src/workers/ai-gateway.ts src/workers/ai-gateway.test.ts
git commit -m "feat(ai): add gateway-routed image/tts/transcription/summarize factories"
```

---

### Task 4: Wire `AI_GATEWAY_MODE` into the worker env + wrangler var

**Files:**
- Modify: `src/workers/index.ts:51-66` (the `EnvBindings` intersection)
- Modify: `wrangler.toml` (add a `[vars]` entry)

- [ ] **Step 1: Add the var to `EnvBindings`**

In `src/workers/index.ts`, import the type and extend the intersection. Add to the imports block:

```ts
import type { AiGatewayMode } from './ai-gateway';
```

Add this property inside the `EnvBindings` object literal (next to `ALLOWED_ORIGINS?: string;`):

```ts
  // E11 ALO-642: selects the AI-Gateway transport mode for ai-gateway.ts.
  // 'gateway-binding' (default) uses { binding: env.AI.gateway('x') };
  // 'run-gateway' uses the env.AI.run('@cf/..', .., { gateway: { id: 'x' } })
  // custom adapter. Never plain { binding: env.AI } (drops observability).
  AI_GATEWAY_MODE?: AiGatewayMode;
```

- [ ] **Step 2: Add the wrangler var**

In `wrangler.toml`, add (under an existing `[vars]` table if present, otherwise create one near the top-level bindings):

```toml
[vars]
# ALO-642: default AI-Gateway transport mode for ai-gateway.ts. Flip to
# "run-gateway" only if env.AI.gateway('x') binding misbehaves for an
# activity on this account (see the E11 AI Studio spec, Appendix B).
AI_GATEWAY_MODE = "gateway-binding"
```

- [ ] **Step 3: Type-check**

Run: `npm run type-check`
Expected: PASS — no type errors from the new import/property.

- [ ] **Step 4: Commit**

```bash
git add src/workers/index.ts wrangler.toml
git commit -m "feat(ai): expose AI_GATEWAY_MODE worker var (default gateway-binding)"
```

---

### Task 5: `run-gateway` custom chat + TTS adapters (de-risking fallback)

Implements the fallback selected by `AI_GATEWAY_MODE=run-gateway`: a custom adapter that calls `env.AI.run('@cf/<model>', input, { gateway: { id: 'x' } })` — identical to today's working `create-tools.ts` call — so that if the gateway *binding* path misbehaves for chat/TTS, we still have a gateway-observable path. **Conform the adapter shape (`kind` + stream/generate method + `StreamChunk` variant) to the interfaces recorded in Task 1 Step 3.** If gateway-binding passed a live smoke test and you want to defer this, that is acceptable — the module already ships a working default; this task only adds the escape hatch.

**Files:**
- Modify: `src/workers/ai-gateway.ts`
- Test: `src/workers/ai-gateway.test.ts`

- [ ] **Step 1: Add the failing test**

Append to `src/workers/ai-gateway.test.ts` (it reuses `gatewayChat`, `makeEnv`, `GATEWAY_ID`, `DEFAULT_CHAT_MODEL` already imported in Task 2):

```ts
describe('ai-gateway run-gateway mode', () => {
  beforeEach(() => vi.clearAllMocks());

  it('chat adapter calls env.AI.run with { gateway: { id: "x" } }, never plain', async () => {
    const env = makeEnv({ AI_GATEWAY_MODE: 'run-gateway' });
    (env.AI.run as any).mockResolvedValue({ response: 'hello world' });

    const adapter: any = gatewayChat(env);
    expect(adapter.kind).toBe('chat');

    // Drive the adapter's streaming method (name per the recorded interface).
    const chunks: any[] = [];
    for await (const c of adapter.stream(
      [{ role: 'user', content: 'hi' }],
      {},
    )) chunks.push(c);

    expect(env.AI.run).toHaveBeenCalledTimes(1);
    const [model, , opts] = (env.AI.run as any).mock.calls[0];
    expect(model).toBe(DEFAULT_CHAT_MODEL);
    expect(opts).toEqual({ gateway: { id: GATEWAY_ID } });
    expect(chunks.map((c) => c.delta ?? c.text).join('')).toContain('hello world');
  });

  it('does not use the gateway-binding path in run-gateway mode', () => {
    const env = makeEnv({ AI_GATEWAY_MODE: 'run-gateway' });
    gatewayChat(env);
    expect(env.AI.gateway).not.toHaveBeenCalled();
  });
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `npx vitest run src/workers/ai-gateway.test.ts`
Expected: FAIL — `adapter.stream is not a function` (run-gateway branch not implemented).

- [ ] **Step 3: Implement the run-gateway branch + custom adapters**

In `src/workers/ai-gateway.ts`, import the adapter types recorded in Task 1, branch `gatewayChat`/`gatewayTts` on the mode, and add the custom adapters. **Method names/return shapes below are the most-likely interface — reconcile with the `.d.ts` recorded in Task 1.**

```ts
import type { ChatAdapter, TTSAdapter, StreamChunk, ModelMessage } from '@tanstack/ai';
```

Replace the chat/tts factories with mode-aware versions:

```ts
export function gatewayChat(env: AiGatewayEnv, model: string = DEFAULT_CHAT_MODEL) {
  if (resolveMode(env) === 'run-gateway') return runGatewayChat(env, model);
  return createWorkersAiChat(model, { binding: gatewayBinding(env) });
}

export function gatewayTts(env: AiGatewayEnv, model: string = DEFAULT_TTS_MODEL) {
  if (resolveMode(env) === 'run-gateway') return runGatewayTts(env, model);
  return createWorkersAiTts(model, { binding: gatewayBinding(env) });
}
```

Add the custom adapters (conform to recorded interfaces):

```ts
/** Custom chat adapter: raw env.AI.run('@cf/..', .., { gateway:{ id:'x' } }).
 *  Same call create-tools.ts makes today — gateway-routed + observable. */
function runGatewayChat(env: AiGatewayEnv, model: string): ChatAdapter {
  return {
    kind: 'chat',
    async *stream(messages: ModelMessage[]): AsyncIterable<StreamChunk> {
      const raw: any = await env.AI.run(
        model,
        { messages, max_tokens: 800 },
        { gateway: { id: GATEWAY_ID } },
      );
      const text: string =
        raw?.response ?? raw?.choices?.[0]?.message?.content ?? '';
      // Emit one text-delta chunk (variant name per recorded StreamChunk).
      yield { type: 'text-delta', delta: text } as unknown as StreamChunk;
    },
  } as ChatAdapter;
}

/** Custom TTS adapter: raw env.AI.run for aura-2; returns base64 audio to
 *  match the @tanstack/ai TTSAdapter result shape (result.audio). */
function runGatewayTts(env: AiGatewayEnv, model: string): TTSAdapter {
  return {
    kind: 'tts',
    async generate({ input, voice }: { input: string; voice?: string }) {
      const raw = await env.AI.run(
        model,
        { text: input, speaker: voice, encoding: 'mp3' },
        { gateway: { id: GATEWAY_ID } },
      );
      const bytes =
        raw instanceof Uint8Array
          ? raw
          : new Uint8Array(raw instanceof ArrayBuffer ? raw : await (raw as Response).arrayBuffer());
      let bin = '';
      for (const b of bytes) bin += String.fromCharCode(b);
      return { audio: btoa(bin), format: 'mp3' };
    },
  } as TTSAdapter;
}
```

> If Task 1 recorded different method names (e.g. `generate` vs `stream` on `ChatAdapter`, or a `result.audio` field name), rename these to match and update the test's driving calls accordingly. The invariant the test enforces — `env.AI.run(model, input, { gateway: { id: 'x' } })` and never the gateway-binding path — does not change.

- [ ] **Step 4: Run to verify it passes**

Run: `npx vitest run src/workers/ai-gateway.test.ts`
Expected: PASS — run-gateway chat calls `env.AI.run` with `{ gateway: { id: 'x' } }` and skips `env.AI.gateway`.

- [ ] **Step 5: Commit**

```bash
git add src/workers/ai-gateway.ts src/workers/ai-gateway.test.ts
git commit -m "feat(ai): add run-gateway custom chat/tts adapters (gateway-routed fallback)"
```

---

### Task 6: Full verification + provider-guard check

**Files:** none (verification only)

- [ ] **Step 1: Run the provider guard**

Run: `npm run lint:no-providers`
Expected: `AI Gateway guard: 0 findings — all model calls route through dynamic/* routes.` (exit 0). If it flags `ai-gateway.ts`, a forbidden model-id string slipped in — only `@cf/*` ids are allowed.

- [ ] **Step 2: Run lint + type-check + the full unit suite + build**

Run: `npm run lint && npm run type-check && npx vitest run src/workers/ai-gateway.test.ts && npm run build`
Expected: all pass; `ai-gateway.test.ts` green; `vite build` succeeds.

- [ ] **Step 3: Final commit (if any lint/type fixes were needed)**

```bash
git add -A
git commit -m "chore(ai): satisfy lint/type-check for ai-gateway transport" || echo "nothing to commit"
```

- [ ] **Step 4: Open the PR (optional, if integrating now)**

```bash
git push -u origin alo-642-ai-gateway-transport
gh pr create --fill --base main
```

---

## Acceptance criteria (from ALO-642) → task mapping

- [ ] Factories exported as named functions taking `env` — Tasks 2, 3.
- [ ] Default mode is gateway-routed (`gateway-binding`); cf-aig observability preserved — Task 2 (test asserts `env.AI.gateway('x')` binding, never plain `env.AI`).
- [ ] Plain `{ binding: env.AI }` is NOT a production default; a test asserts gateway routing — Task 2 Step 1.
- [ ] `AI_GATEWAY_MODE` switches between `gateway-binding` and `run-gateway` — Tasks 4, 5.
- [ ] `node scripts/check-no-direct-providers.mjs` exits 0 with the new module present — Task 6.

## Notes / follow-ups

- This task deliberately does **not** touch `create-tools.ts` — that migration is **ALO-643** and consumes `gatewayChat`/`gatewayTts` from here.
- Before launch, run the per-activity gateway-binding smoke test from spec Appendix-B (chat/image/tts/transcription) and confirm `cf-aig-*` headers appear in the gateway `x` dashboard. If any activity misbehaves, set `AI_GATEWAY_MODE=run-gateway` (chat/TTS covered; extend `runGateway*` to image/transcription/summarize if needed).
- `@tanstack/ai-react` is installed here for ALO-645's `useChat` UI; it is unused by this server module.
