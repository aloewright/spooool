# create-tools.ts → @tanstack/ai Refactor — ALO-643

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Migrate the three AI tool implementations in `src/workers/create-tools.ts` (`draftScript`, `planScenes`, `synthesizeTts`) off raw `env.AI.run(...)` and onto `@tanstack/ai`'s `chat()` / `generateSpeech()` activities driven by the `ai-gateway.ts` factories — keeping public signatures, hard caps, gateway routing, observability, content-policy masking, and `lint:no-providers` green.

**Architecture:** `create-tools.ts` keeps its own retry/backoff/cap/content-policy wrapper logic but delegates the actual model call to `chat({ adapter: gatewayChat(env), … })` and `generateSpeech({ adapter: gatewayTts(env), … })` from ALO-642's `src/workers/ai-gateway.ts`. `planScenes` drops its hand-rolled JSON parse-or-reprompt in favor of `chat({ outputSchema })`. `finalizeRender` is unchanged. Production runs the default `gateway-binding` mode; unit tests run in `run-gateway` mode (set `AI_GATEWAY_MODE: 'run-gateway'` on the test env) so the existing `env.AI.run`-boundary assertions (model id + `{ gateway: { id: 'x' } }` + input shape) still hold and prove byte-for-byte parity through the real adapter path.

**Tech Stack:** TypeScript · Cloudflare Workers (`env.AI`) · `@tanstack/ai` (`chat`, `generateSpeech`) + `src/workers/ai-gateway.ts` (`gatewayChat`/`gatewayTts`, `AiGatewayEnv`, `AiGatewayMode`) · zod v4 · vitest (node env).

**Depends on:** ALO-642 (`ai-gateway.ts`), present on this branch's ancestor `alo-642-ai-gateway-transport`. This branch (`alo-643-create-tools-tanstack`) is stacked on it.

---

## Context an engineer needs

- **Current file:** `src/workers/create-tools.ts` exports `draftScript({template, answers, env})`, `planScenes({script, template, env})`, `synthesizeTts({script, voice, jobId, env})`, `finalizeRender(...)`, plus types `SceneSpec`, `VoiceProfile`, `AIBindingEnv`, `AIGatewayEnv`, `R2BindingEnv`, and helpers `auraSpeaker(profile)`, `isContentPolicyMsg(msg)`. Hard caps: `MAX_SCRIPT_CHARS=1500`, `MAX_SCENES=20`, `MAX_TTS_CHARS=2000`. Today it calls `env.AI.run('@cf/google/gemma-4-26b-a4b-it', {messages, max_tokens:800}, {gateway:{id:'x'}})` (chat) and `env.AI.run('@cf/deepgram/aura-2-en', {text, speaker, encoding:'mp3'}, {gateway:{id:'x'}})` (tts).
- **Consumers that MUST keep compiling unchanged:** `src/workers/create-cma.ts` and `src/workers/composer-agent-do.ts` import `{ draftScript, planScenes, synthesizeTts, finalizeRender, AIBindingEnv, AIGatewayEnv, R2BindingEnv, SceneSpec }` and call the functions with the same arg objects (`{template, answers, env}` etc.). **Do not change their call sites.** They pass the DO/agent `env`, which is the full worker env (has the real `Ai` binding with `.run` + `.gateway`).
- **ai-gateway.ts (ALO-642) exports:** `gatewayChat(env, model?)`, `gatewayTts(env, model?)`, `gatewayImage/Transcription/Summarize`, `GATEWAY_ID='x'`, `resolveMode(env)`, `type AiGatewayMode`, `interface AiGatewayEnv { AI: AiBinding; AI_GATEWAY_MODE?: AiGatewayMode }`, `DEFAULT_CHAT_MODEL='@cf/google/gemma-4-26b-a4b-it'`, `DEFAULT_TTS_MODEL='@cf/deepgram/aura-2-en'`. In `run-gateway` mode `gatewayChat`/`gatewayTts` return custom adapters that call `env.AI.run('@cf/..', input, {gateway:{id:'x'}})`; in `gateway-binding` they wrap `@cloudflare/tanstack-ai` against `env.AI.gateway('x')`.
- **@tanstack/ai activity API (verified):** `await chat({ adapter, messages, stream:false })` → `string`. `await chat({ adapter, messages, outputSchema })` → the parsed object (zod/standard-schema; chat unwraps `.data`). `await generateSpeech({ adapter, text, voice?, format? })` → `TTSResult { id, model, audio /* BASE64 */, format, ... }`. `messages` accept `{ role, content: string }`.
- **Test boundary:** the existing `create-tools.test.ts` builds an env whose `AI.run` is a stub and whose `AI.gateway()` throws. Add `AI_GATEWAY_MODE: 'run-gateway'` to those envs so `chat()`/`generateSpeech()` route through the custom adapters → `env.AI.run`, preserving the existing assertions. Call counts may shift by the `chat()` wrapper — adjust to observed behavior (the spike measures this).
- **Lint:** `scripts/check-no-direct-providers.mjs` allows `@cf/*` ids + `@tanstack/ai`/`ai-gateway` imports; keep it green.

## File Structure

| File | Change |
|---|---|
| `src/workers/create-tools.ts` | Replace `chatComplete` raw calls with `chat()`; `planScenes` → `chat({outputSchema})`; `synthesizeTts` → `generateSpeech()` + base64 decode; reconcile env type to `AiGatewayEnv`. Keep caps, retry/backoff, content-policy mask, `auraSpeaker`, `finalizeRender`. |
| `src/workers/create-tools.test.ts` | Set `AI_GATEWAY_MODE:'run-gateway'` on test envs; update `planScenes` tests for `outputSchema`; adjust call counts to observed. |

---

### Task 1: Spike — pin chat()/generateSpeech() behavior + env-type reconciliation

Resolve the unknowns before editing: exact `chat()` call-count/return behavior through the run-gateway adapter, `outputSchema` acceptance of a zod object, the `generateSpeech` field names, and how `create-tools`' `env` param type must change so `gatewayChat(env)` type-checks without touching the consumers.

**Files:** none (investigation; may write a throwaway scratch test, then delete it).

- [ ] **Step 1: Confirm env-type reconciliation**
Read `src/workers/ai-gateway.ts` (the `AiBinding`/`AiGatewayEnv` types) and `src/workers/create-tools.ts` (the `AIBindingEnv` type) and `src/workers/create.ts` (`CreateEnv`) + `src/workers/composer-agent-do.ts` (its `env` field type). Determine the minimal change so `create-tools` functions can call `gatewayChat(args.env)`:
  - Preferred: change the functions' `env` param type from `AIBindingEnv` to `AiGatewayEnv` (import it from `./ai-gateway`), and re-export `AiGatewayEnv` (or keep `AIBindingEnv` as a deprecated alias `export type AIBindingEnv = AiGatewayEnv` if consumers import the name) so `create-cma.ts`/`composer-agent-do.ts` still compile.
  - Verify the worker env the consumers pass satisfies `AiGatewayEnv` (run `npm run type-check` against a scratch edit). Record the exact approach that keeps `create-cma.ts`/`composer-agent-do.ts` compiling with no edits to their call sites.

- [ ] **Step 2: Measure chat() behavior through run-gateway**
Write a throwaway `src/workers/_scratch.test.ts` that imports `chat`, `generateSpeech` from `@tanstack/ai` and `gatewayChat`/`gatewayTts` from `./ai-gateway`, builds an env with `AI_GATEWAY_MODE:'run-gateway'` and a stubbed `AI.run`, and runs:
  - `await chat({ adapter: gatewayChat(env), messages: [{role:'user',content:'hi'}], stream:false })` — record: return type (string?), and how many times `AI.run` was called.
  - `await chat({ adapter: gatewayChat(env), messages:[...], outputSchema: z.object({ scenes: z.array(z.object({type:z.enum(['title','beat','outro']),durationFrames:z.number(),text:z.string(),subtitle:z.string().optional()})) }) })` with `AI.run` returning `{ response: JSON.stringify({scenes:[{type:'title',durationFrames:90,text:'x'}]}) }` — record: does it return the parsed object directly? `.scenes` present? On malformed JSON, does it throw or retry (call count)?
  - `await generateSpeech({ adapter: gatewayTts(env), text:'hi', voice:'asteria-en', format:'mp3' })` with `AI.run` returning `new Uint8Array([1,2,3,4])` — record: `result.audio` base64 decodes to `[1,2,3,4]`? what model/input/opts did `AI.run` receive (confirm `{text, speaker:'asteria-en', encoding:'mp3'}` + `{gateway:{id:'x'}}`)?
Run `npx vitest run src/workers/_scratch.test.ts`, record all findings, then DELETE `_scratch.test.ts`.

- [ ] **Step 3: Record findings** (paste into the report): the env-type approach; chat() stream:false return + call count; outputSchema return shape + malformed behavior + call count; generateSpeech result + the AI.run args. These drive Tasks 2-4's exact assertions. No commit (no source changed).

---

### Task 2: Refactor `draftScript` onto `chat()`

**Files:** Modify `src/workers/create-tools.ts`; Test `src/workers/create-tools.test.ts`.

- [ ] **Step 1: Update the test env to run-gateway + keep draftScript assertions**
In `create-tools.test.ts`, change the `aiTextEnv(...)` helper so the returned env includes `AI_GATEWAY_MODE: 'run-gateway'` (so `chat()` routes through the custom adapter to `env.AI.run`). Keep the existing `draftScript` assertions (model `@cf/google/gemma-4-26b-a4b-it`, `opts.gateway.id==='x'`, system/user message roles, 1500-char cap). Adjust the retry test's expected `_calls.length` to the value the spike measured for 3 attempts (likely still 3 if `draftScript` keeps its own retry loop and chat() calls AI.run once per attempt).
Run `npx vitest run src/workers/create-tools.test.ts -t draftScript` → expect FAIL (still calls old `chatComplete`).

- [ ] **Step 2: Replace `chatComplete` with `chat()` inside `draftScript`'s retry loop**
Keep `draftScript`'s signature, the system/user message construction, the `MAX_SCRIPT_CHARS` slice, and the retry/backoff + `Script generation failed:` error wrapping. Replace the per-attempt `chatComplete({route, messages, env}, retries)` call with:
```ts
const content = await chat({ adapter: gatewayChat(args.env), messages, stream: false });
```
(import `chat` from `@tanstack/ai`, `gatewayChat` from `./ai-gateway`). If `chatComplete` is now only used by `draftScript`, inline the retry loop here or keep `chatComplete` as a thin wrapper over `chat()` reused by both chat call sites — your call; keep it DRY. Remove the now-dead `env.AI.run` chat path + `TEXT_MODEL`/`ChatCompletionResponse` shapes if nothing else uses them.
Run the draftScript tests → expect PASS.

- [ ] **Step 3: Commit**
```bash
git add src/workers/create-tools.ts src/workers/create-tools.test.ts
git commit -m "refactor(create): draftScript via @tanstack/ai chat() (gateway-routed)"
```

---

### Task 3: Refactor `planScenes` onto `chat({ outputSchema })`

**Files:** Modify `src/workers/create-tools.ts`; Test `src/workers/create-tools.test.ts`.

- [ ] **Step 1: Rewrite the planScenes tests for outputSchema**
The hand-rolled JSON parse + 1-reprompt is replaced by `outputSchema`, so the "re-prompts once on malformed JSON, then throws" test changes. New tests (run-gateway env):
  - returns parsed scenes: `AI.run` resolves `{ response: JSON.stringify({ scenes: [...] }) }`; assert `result.scenes` equals the input scenes (post-processing applied: `durationFrames` floored to ≥1).
  - caps to 20: 50 scenes in → `result.scenes` length 20.
  - invalid output throws `Scene plan invalid`: `AI.run` resolves non-JSON / schema-violating; assert it rejects with `/Scene plan invalid/` (match the spike's malformed behavior — if `chat({outputSchema})` throws, wrap that throw into the `Scene plan invalid` message).
Run `npx vitest run src/workers/create-tools.test.ts -t planScenes` → expect FAIL.

- [ ] **Step 2: Implement planScenes via chat({ outputSchema })**
Define the zod schema near the top of the file:
```ts
import { z } from 'zod';
const sceneSchema = z.object({
  scenes: z.array(z.object({
    type: z.enum(['title', 'beat', 'outro']),
    durationFrames: z.number(),
    text: z.string(),
    subtitle: z.string().optional(),
  })),
});
```
Replace the body of `planScenes` with: build the same system+user messages, then
```ts
let parsed: { scenes: SceneSpec[] };
try {
  parsed = await chat({ adapter: gatewayChat(args.env), messages, outputSchema: sceneSchema });
} catch (err) {
  throw new Error(`Scene plan invalid: ${err instanceof Error ? err.message : String(err)}`);
}
const scenes = parsed.scenes.slice(0, MAX_SCENES).map((s) => ({
  ...s,
  durationFrames: Math.max(1, Math.floor(s.durationFrames)),
}));
return { scenes };
```
Remove the old `parseOrThrow`/`tryOnce` hand-rolled logic. Keep `MAX_SCENES`.
Run the planScenes tests → expect PASS.

- [ ] **Step 3: Commit**
```bash
git add src/workers/create-tools.ts src/workers/create-tools.test.ts
git commit -m "refactor(create): planScenes via chat({ outputSchema }) — drop hand-rolled JSON parse"
```

---

### Task 4: Refactor `synthesizeTts` onto `generateSpeech()`

**Files:** Modify `src/workers/create-tools.ts`; Test `src/workers/create-tools.test.ts`.

- [ ] **Step 1: Update the synthesizeTts tests to run-gateway + base64 path**
Set `AI_GATEWAY_MODE:'run-gateway'` on the `aiEnv(...)` helper's env. The custom run-gateway TTS adapter returns base64 `result.audio`; `synthesizeTts` decodes it before `VIDEOS.put`. Keep assertions: `AI.run` called with `@cf/deepgram/aura-2-en`, input `{text:'Hello world.', speaker:'asteria-en', encoding:'mp3'}`, `opts.gateway.id==='x'`; R2 put `recorder/tts/j_abc.mp3` contentType `audio/mpeg`; the persisted bytes equal the original `[0xff,0xfb,0x90,0x00]` (assert `r2._puts[0].bytes === 4` — proves base64 round-trips, no double-encode). Keep the 2000-char cap, content-policy mask, and upstream-error tests (these should pass unchanged since the error originates from `env.AI.run` and propagates through the adapter; verify the content-policy `isContentPolicyMsg` mask still triggers — the rejection message must still reach `synthesizeTts`).
Run `npx vitest run src/workers/create-tools.test.ts -t synthesizeTts` → expect FAIL.

- [ ] **Step 2: Implement synthesizeTts via generateSpeech()**
Keep the `MAX_TTS_CHARS` guard, `auraSpeaker(args.voice.profile)` resolution, the content-policy mask (`isContentPolicyMsg`), the `TTS synthesis failed:` wrapping, the R2 `put` with 3× backoff, and the `durationMs` estimate. Replace the `env.AI.run(TTS_MODEL, {...}, {gateway})` call + the raw-bytes handling with:
```ts
let result: { audio: string };
try {
  result = await generateSpeech({ adapter: gatewayTts(args.env), text: args.script, voice: auraSpeaker(args.voice.profile), format: 'mp3' });
} catch (err) {
  const msg = err instanceof Error ? err.message : String(err);
  if (isContentPolicyMsg(msg)) { console.error('[create-tools] tts content-policy refusal', msg.slice(0,500)); throw new Error('Generation failed, please try rephrasing your prompt.'); }
  throw new Error(`TTS synthesis failed: ${msg.slice(0,200)}`);
}
// base64 → bytes
const bin = atob(result.audio);
const audioBytes = new Uint8Array(bin.length);
for (let i = 0; i < bin.length; i++) audioBytes[i] = bin.charCodeAt(i);
if (audioBytes.byteLength === 0) throw new Error('TTS synthesis returned empty audio');
```
Then `VIDEOS.put(r2Key, audioBytes, { httpMetadata: { contentType: 'audio/mpeg' } })` (keep the existing 3× retry). Remove the old `TTS_MODEL`/`TTS_GATEWAY_ID` raw-call + the `raw instanceof Response/Uint8Array` narrowing (the adapter now owns byte handling). Import `generateSpeech` from `@tanstack/ai`, `gatewayTts` from `./ai-gateway`.
Run the synthesizeTts tests → expect PASS.

- [ ] **Step 3: Commit**
```bash
git add src/workers/create-tools.ts src/workers/create-tools.test.ts
git commit -m "refactor(create): synthesizeTts via generateSpeech() + base64 decode"
```

---

### Task 5: Env-type reconciliation + full verification

**Files:** Modify `src/workers/create-tools.ts` (types/exports as needed); verify across consumers.

- [ ] **Step 1: Apply the env-type approach from Task 1**
Change the three functions' `env` param to `AiGatewayEnv` (imported from `./ai-gateway`); keep `R2BindingEnv & AiGatewayEnv` for `synthesizeTts`. Preserve the exported type names the consumers import (`AIBindingEnv`, `AIGatewayEnv`, `R2BindingEnv`, `SceneSpec`, `VoiceProfile`) — if `AIBindingEnv` is no longer the param type, keep it exported as a compatible alias so `create-cma.ts`/`composer-agent-do.ts` imports still resolve. Do NOT edit `create-cma.ts`/`composer-agent-do.ts`.

- [ ] **Step 2: Full gate**
Run:
```bash
npm run type-check        # whole repo, incl. create-cma.ts + composer-agent-do.ts
npx vitest run src/workers/create-tools.test.ts   # all create-tools tests green
npm run lint:no-providers # 0 findings
npm run lint              # 0 errors
npm run build             # exit 0
```
All must pass. If `type-check` flags `create-cma.ts`/`composer-agent-do.ts`, fix the type compatibility in `create-tools.ts`/`ai-gateway.ts` (NOT by editing the consumers' logic) until they compile.

- [ ] **Step 3: Commit**
```bash
git add -A
git commit -m "refactor(create): reconcile create-tools env type to AiGatewayEnv; full gate green"
```

---

## Acceptance criteria (ALO-643) → task mapping
- [ ] `draftScript`/`planScenes`/`synthesizeTts`/`finalizeRender` keep identical signatures + char/scene caps — Tasks 2-5 (finalizeRender untouched).
- [ ] `planScenes` uses `outputSchema` and returns valid `SceneSpec[]` (≤20) — Task 3.
- [ ] `synthesizeTts` base64-decodes adapter audio and writes the same `recorder/tts/{jobId}.mp3` key — Task 4.
- [ ] Calls remain gateway-routed (tests assert `env.AI.run` with `{gateway:{id:'x'}}`, not a bare binding) — Tasks 2-4 (run-gateway test mode).
- [ ] `lint:no-providers` stays green — Task 5.

## Notes / risks
- **Production runs `gateway-binding` (default); tests run `run-gateway`.** The runtime gateway-binding path is unverified on this account (spec Appendix B) — before relying on the live prompt-to-video flow, smoke-test it and, if it misbehaves, set `AI_GATEWAY_MODE=run-gateway` (the proven path these tests cover). Note this in the deploy runbook.
- If `chat({outputSchema})` does NOT throw on schema violation (returns a default/empty), Task 3's "invalid throws" test must assert on the post-validation shape instead; conform to the spike's measurement.
- Do not modify `composer-agent-do.ts` / `create-cma.ts`. If they fail type-check, the fix belongs in `create-tools.ts`/`ai-gateway.ts` types.
