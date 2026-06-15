//
// Tool implementations for the prompt-to-video agent (sub-project #4).
// Each tool wraps an AI Gateway dynamic route per CLAUDE.md's "never call
// providers directly" rule. Pure of side effects beyond the explicit
// network / R2 calls so unit tests can mock fetch.

import { chat, generateSpeech } from '@tanstack/ai';
import { z } from 'zod';
import type { StoryTemplate, VoiceProfile } from './create/templates/types';
import { submitRenderJob as defaultSubmitRenderJob, type RenderEnv, type SubmitRenderJobInput } from './render';
import { gatewayChat, gatewayTts, type AiGatewayEnv } from './ai-gateway';

/**
 * Kept for backward-compat with downstream env intersections
 * (`CreateEnv`, `ComposerAgentEnv`, `CMAEnv` all extend it). The fields
 * are no longer consumed by `chatComplete` — text gen routes through
 * `gatewayChat` (either gateway-binding or run-gateway mode) — but other
 * code paths may still reference these worker secrets, so we keep the
 * type around.
 */
export interface AIGatewayEnv {
  CF_ACCOUNT_ID: string;
  CF_GATEWAY_ID: string;
  CF_AIG_TOKEN: string;
}

export interface SceneSpec {
  type: 'title' | 'beat' | 'outro';
  durationFrames: number;
  text: string;
  subtitle?: string;
}

const MAX_SCRIPT_CHARS = 1500;
const MAX_SCENES = 20;

/**
 * Zod schema for the LLM-returned scene plan. Matches SceneSpec exactly so
 * the inferred type is structurally compatible and no assertion is needed.
 */
const sceneSchema = z.object({
  scenes: z.array(z.object({
    type: z.enum(['title', 'beat', 'outro']),
    durationFrames: z.number(),
    text: z.string(),
    subtitle: z.string().optional(),
  })),
});

/**
 * Shared text-gen helper. Routes through @tanstack/ai `chat()` via the
 * `gatewayChat` adapter (run-gateway mode → env.AI.run('@cf/google/gemma-4-26b-a4b-it',
 * { messages, max_tokens: 800 }, { gateway: { id: 'x' } }) per CLAUDE.md
 * "Working pattern from a Worker today").
 *
 * No retries here — callers own their own retry / re-prompt logic:
 * draftScript's loop retries up to 3×; planScenes relies on chat({outputSchema})
 * which validates internally and throws on malformed output without retrying.
 * One call = one env.AI.run invocation.
 *
 * Why we iterate the stream instead of using stream:false: when env.AI.run
 * throws, runGatewayChat converts the error into a RUN_ERROR chunk rather than
 * re-throwing. With stream:false, chat() would return '' (no TEXT_MESSAGE_CONTENT
 * chunks). By iterating manually we can detect RUN_ERROR and re-throw so callers'
 * retry loops work correctly.
 *
 * Why `env as unknown as AiGatewayEnv`: the real Worker `Ai` binding structurally
 * satisfies BOTH `AIGatewayBinding` and ai-gateway.ts's `CloudflareAiGateway` shapes
 * at runtime. The only mismatch is a tsc-level `Promise<unknown>` vs `Promise<Response>`
 * divergence on the gateway `run` return type — `AIGatewayBinding.run` returns
 * `Promise<unknown>` while `AiGatewayEnv`'s `CloudflareAiGateway.run` returns
 * `Promise<Response>`. The cast bridges that divergence without editing either consumer.
 * Note: in gateway-binding mode (the production default), `gatewayChat` DOES call
 * `env.AI.gateway('x')` via `createWorkersAiChat`; the cast is safe because the real
 * binding satisfies both shapes. See CLAUDE.md "Inside a Worker" for the full breakdown.
 * TODO: remove cast when `CloudflareAiGateway.run` is widened to `Promise<unknown>`
 * upstream without breaking createWorkersAi* factory calls in ai-gateway.ts.
 */
async function chatComplete(
  args: {
    route: 'dynamic/text_gen';
    messages: Array<{ role: 'system' | 'user' | 'assistant'; content: string }>;
    env: AIBindingEnv;
  },
): Promise<string> {
  const systemMessages = args.messages.filter((m) => m.role === 'system');
  const conversationMessages = args.messages.filter(
    (m): m is { role: 'user' | 'assistant'; content: string } => m.role !== 'system',
  );
  // Cast required: AIBindingEnv.AI.gateway returns AIGatewayBinding (run → Promise<unknown>)
  // while AiGatewayEnv.AI.gateway returns CloudflareAiGateway (run → Promise<Response>).
  // Safe at runtime: the real Ai binding satisfies both shapes; only the tsc return-type
  // divergence on gateway().run requires the cast. See doc comment above for full context.
  const stream = chat({
    adapter: gatewayChat(args.env as unknown as AiGatewayEnv),
    systemPrompts: systemMessages.map((m) => m.content),
    messages: conversationMessages,
  });
  let text = '';
  for await (const chunk of stream) {
    if (chunk.type === 'RUN_ERROR') {
      // RUN_ERROR carries the provider message differently per mode: run-gateway
      // sets a flat `message`; the @cloudflare gateway-binding adapter nests it as
      // `error.message` — and @tanstack/ai's strip-to-spec middleware may remove the
      // nested `error` before this consumer sees it, in which case only the generic
      // string is available. For full provider diagnostics, run in run-gateway mode.
      const c = chunk as { message?: unknown; error?: { message?: unknown } };
      const msg = (typeof c.message === 'string' && c.message)
        || (typeof c.error?.message === 'string' && c.error.message)
        || 'AI Gateway call failed';
      throw new Error(msg);
    }
    if (chunk.type === 'TEXT_MESSAGE_CONTENT' && 'delta' in chunk && typeof chunk.delta === 'string') {
      text += chunk.delta;
    }
  }
  return text;
}

export async function draftScript(args: {
  template: StoryTemplate;
  answers: Record<string, string>;
  env: AIBindingEnv;
}): Promise<{ script: string }> {
  const answersBlock = Object.entries(args.answers)
    .map(([qid, a]) => `Q[${qid}]: ${a}`)
    .join('\n');
  const messages = [
    {
      role: 'system' as const,
      content: `${args.template.systemPromptFragment}\nProduce only the narration text, no scene headers, no markdown.`,
    },
    { role: 'user' as const, content: answersBlock || 'No answers provided; invent plausible details consistent with the template.' },
  ];
  // Retry loop: up to 3 total attempts (initial + 2 retries). chatComplete()
  // calls chat() once per invocation — one env.AI.run per attempt.
  const MAX_ATTEMPTS = 3;
  let lastErr: unknown = null;
  for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt++) {
    try {
      const content = await chatComplete({ route: 'dynamic/text_gen', messages, env: args.env });
      return { script: content.slice(0, MAX_SCRIPT_CHARS) };
    } catch (err) {
      lastErr = err;
      const msg = err instanceof Error ? err.message : String(err);
      // Don't retry on hard client errors (4xx / invalid request).
      if (/\b4\d\d\b/.test(msg) || /invalid|bad request|not found/i.test(msg)) break;
    }
    if (attempt < MAX_ATTEMPTS - 1) await new Promise((r) => setTimeout(r, 500 * (attempt + 1)));
  }
  const msg = lastErr instanceof Error ? lastErr.message : String(lastErr);
  throw new Error(`Script generation failed: ${msg}`);
}

export async function planScenes(args: {
  script: string;
  template: StoryTemplate;
  env: AIBindingEnv;
}): Promise<{ scenes: SceneSpec[] }> {
  const systemPrompt = `${args.template.systemPromptFragment}\nReturn ONLY a JSON object of shape { "scenes": [{ "type": "title"|"beat"|"outro", "durationFrames": number, "text": string, "subtitle"?: string }] }. Use 30fps; the sum of durationFrames must be 1800-2700 (60-90 seconds). Do NOT include any commentary outside the JSON.`;
  const userMessage = { role: 'user' as const, content: `Script:\n${args.script}\n\nTemplate scene plan hints:\n${JSON.stringify(args.template.scenePlan)}` };

  // Use chat({ outputSchema }) to get structured output in one env.AI.run call.
  // On malformed or schema-invalid output, @tanstack/ai throws internally —
  // we catch and re-wrap with a stable "Scene plan invalid:" prefix.
  // Cast mirrors chatComplete's cast: see doc comment on chatComplete above for
  // the AIBindingEnv → AiGatewayEnv divergence explanation.
  // TODO: remove cast when CloudflareAiGateway.run is widened to Promise<unknown>.
  let parsed: z.infer<typeof sceneSchema>;
  try {
    parsed = await chat({
      adapter: gatewayChat(args.env as unknown as AiGatewayEnv),
      systemPrompts: [systemPrompt],
      messages: [userMessage],
      outputSchema: sceneSchema,
    });
  } catch (err) {
    throw new Error(`Scene plan invalid: ${err instanceof Error ? err.message : String(err)}`);
  }
  const scenes = parsed.scenes.slice(0, MAX_SCENES).map((s) => ({
    ...s,
    durationFrames: Math.max(1, Math.floor(s.durationFrames)),
  }));
  return { scenes };
}

// Re-export VoiceProfile for downstream tools / tests.
export type { VoiceProfile };

export interface R2BindingEnv {
  VIDEOS: R2Bucket;
}

/**
 * Workers AI binding. Required by `synthesizeTts` because:
 *
 *   1. AI Gateway's `/compat/audio/speech` endpoint returns error 2019
 *      ("Compatibility endpoint: audio/speech is not supported").
 *   2. The `dynamic/tts` route's compat layer doesn't translate chat-shape
 *      input to provider TTS APIs — when called via `/compat/chat/completions`
 *      with `messages: [...]`, the gateway forwards the body verbatim to
 *      the underlying provider (Vertex Gemini primary / Workers AI Deepgram
 *      fallback), which then complains about missing `text` field / etc.
 *   3. Per CLAUDE.md, the working pattern from inside a Worker is
 *      `env.AI.run("@cf/...", input, { gateway: { id: '...' } })` — that
 *      hits the model directly via the Workers AI binding while routing
 *      through the named gateway for observability + caching.
 *
 * We point at the `spooool` gateway so all TTS calls show up in that
 * dashboard alongside the dynamic-route invocations.
 */
/**
 * Shape of `env.AI.gateway(slug).run({...})` — the Workers-AI-binding
 * call that invokes a Cloudflare AI Gateway route from inside a Worker.
 * Retained for backward-compat typing of `AIBindingEnv`; the gateway-binding
 * transport is used by `chatComplete` in production (gateway-binding mode)
 * via `gatewayChat` → `createWorkersAiChat({ binding: env.AI.gateway('x') })`.
 * Auth is handled by the binding itself; no CF_AIG_TOKEN required.
 */
interface AIGatewayBinding {
  run: (body: {
    provider: 'compat';
    endpoint: 'chat/completions';
    headers?: Record<string, string>;
    query: {
      model: string;
      messages: Array<{ role: 'system' | 'user' | 'assistant'; content: string }>;
      [k: string]: unknown;
    };
  }) => Promise<unknown>;
}

export interface AIBindingEnv {
  AI: {
    gateway: (slug: string) => AIGatewayBinding;
    run: (
      model: string,
      input: Record<string, unknown>,
      opts?: { gateway?: { id: string; skipCache?: boolean } },
    ) => Promise<ArrayBuffer | Uint8Array | Response>;
  };
}

const MAX_TTS_CHARS = 2000;

/**
 * Voice profile → Deepgram Aura speaker. Aura ships ~40 named voices; we
 * pick three representative ones for our three profiles. Update when we
 * add more profiles.
 */
function auraSpeaker(profile: VoiceProfile): string {
  if (profile === 'warm') return 'asteria-en';
  if (profile === 'energetic') return 'orion-en';
  return 'arcas-en';
}

function isContentPolicyMsg(msg: string): boolean {
  return /content[_ ]policy|safety/i.test(msg);
}

export async function synthesizeTts(args: {
  script: string;
  voice: { profile: VoiceProfile; pacingWpm: number };
  jobId: string;
  env: R2BindingEnv & AIBindingEnv;
}): Promise<{ r2Key: string; durationMs: number }> {
  if (args.script.length > MAX_TTS_CHARS) throw new Error('script too long for TTS');

  // Route through @tanstack/ai generateSpeech() + gatewayTts adapter.
  // In run-gateway mode (tests + production fallback), gatewayTts selects
  // runGatewayTts which calls env.AI.run('@cf/deepgram/aura-2-en', ...,
  // { gateway: { id: 'x' } }) and base64-encodes the result into TTSResult.audio.
  // Cast required: AIBindingEnv.AI diverges from AiGatewayEnv.AI on
  // gateway().run return type (Promise<unknown> vs Promise<Response>).
  // Safe at runtime — see chatComplete doc comment for the full explanation.
  // TODO: remove cast when CloudflareAiGateway.run is widened to Promise<unknown>.
  let result: { audio: string };
  try {
    result = await generateSpeech({
      adapter: gatewayTts(args.env as unknown as AiGatewayEnv, undefined, { op: 'tts' }),
      text: args.script,
      voice: auraSpeaker(args.voice.profile),
      format: 'mp3',
    });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    if (isContentPolicyMsg(msg)) {
      console.error('[create-tools] tts content-policy refusal', msg.slice(0, 500));
      throw new Error('Generation failed, please try rephrasing your prompt.');
    }
    throw new Error(`TTS synthesis failed: ${msg.slice(0, 200)}`);
  }

  // runGatewayTts returns base64-encoded audio in TTSResult.audio; decode it
  // to raw bytes before writing to R2.
  const bin = atob(result.audio);
  const audioBytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) audioBytes[i] = bin.charCodeAt(i);
  if (audioBytes.byteLength === 0) throw new Error('TTS synthesis returned empty audio');

  const r2Key = `recorder/tts/${args.jobId}.mp3`;
  let putErr: unknown = null;
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      await args.env.VIDEOS.put(r2Key, audioBytes, { httpMetadata: { contentType: 'audio/mpeg' } });
      putErr = null;
      break;
    } catch (err) {
      putErr = err;
      await new Promise((r) => setTimeout(r, 250 * 2 ** attempt));
    }
  }
  if (putErr) throw new Error(`TTS upload failed: ${putErr instanceof Error ? putErr.message : String(putErr)}`);

  // Estimate duration from words + pacing; the renderer reads the actual
  // mp3 length, this is only a hint for status UI.
  const words = args.script.trim().split(/\s+/).length;
  const durationMs = Math.round((words / args.voice.pacingWpm) * 60_000);

  return { r2Key, durationMs };
}

export interface FinalizeRenderInput {
  userId: string;
  scenes: SceneSpec[];
  /**
   * R2 key of the synthesized voice-over mp3. Optional — when undefined
   * the explainer renders silently (TTS failure shouldn't block the
   * video, the user still gets the visuals). The composition + container
   * both guard against missing audio.
   */
  ttsR2Key?: string;
  env: RenderEnv;
  /**
   * Pre-supplied jobId — passed through to `submitRenderJob` as
   * `existingJobId`. Callers use this to thread ONE id end-to-end so the
   * TTS R2 key (`recorder/tts/{jobId}.mp3`) matches the final render job
   * row. When provided, the caller is also expected to have pre-inserted
   * the render_jobs row (see `submitRenderJob` for the contract).
   */
  existingJobId?: string;
  /** Injected for tests; defaults to the real `submitRenderJob`. */
  submitRenderJob?: (input: SubmitRenderJobInput) => Promise<{ jobId: string }>;
}

export async function finalizeRender(input: FinalizeRenderInput): Promise<{ jobId: string }> {
  const submit = input.submitRenderJob ?? defaultSubmitRenderJob;
  const compositionProps: Record<string, unknown> = {
    compositionId: 'spooool-explainer',
    scenes: input.scenes,
    brand: { color: '#0a84ff' },
  };
  if (input.ttsR2Key) compositionProps.audio = { r2Key: input.ttsR2Key };
  return submit({
    userId: input.userId,
    takeKeys: [], // no recorder takes for prompt-to-video
    compositionProps,
    env: input.env,
    existingJobId: input.existingJobId,
  });
}
