/**
 * ai-gateway.ts — single gateway-routed transport for all @tanstack/ai activities.
 *
 * Every factory here routes through `env.AI.gateway(GATEWAY_ID)` (the AI Gateway
 * binding) to preserve cf-aig observability, caching, rate limits, and cost routing.
 * Passing `{ binding: env.AI }` (plain Workers AI binding) is FORBIDDEN — the
 * @cloudflare/tanstack-ai plain-binding mode calls `binding.run(model, inputs,
 * {extraHeaders, signal})` with no gateway, which drops all observability.
 *
 * Why `@cf/<model>` ids instead of `dynamic/*` slugs:
 *   - `env.AI.gateway(id).run(...)` resolves through AI Gateway and supports
 *     the gateway binding path with concrete model ids.
 *   - `dynamic/*` slugs are NOT resolvable via `env.AI.run("dynamic/foo", ...)` —
 *     the binding treats the first arg as a literal Workers AI model id and 404s.
 *   See /Users/aloe/.claude/CLAUDE.md "Inside a Worker" for the full breakdown.
 */

import type { TextAdapter, TextOptions, TTSAdapter, TTSOptions, TTSResult, StreamChunk, SystemPrompt, ModelMessage } from '@tanstack/ai';
// StructuredOutput{Options,Result} are only re-exported from the /adapters subpath,
// not the package root (the root's adapter re-export list omits them).
import type { StructuredOutputOptions, StructuredOutputResult } from '@tanstack/ai/adapters';
import { createWorkersAiChat } from '@cloudflare/tanstack-ai/adapters/workers-ai';
import { createWorkersAiImage } from '@cloudflare/tanstack-ai/adapters/workers-ai-image';
import { createWorkersAiTts } from '@cloudflare/tanstack-ai/adapters/workers-ai-tts';
import { createWorkersAiTranscription } from '@cloudflare/tanstack-ai/adapters/workers-ai-transcription';
import { createWorkersAiSummarize } from '@cloudflare/tanstack-ai/adapters/workers-ai-summarize';

export const GATEWAY_ID = 'x';

export type AiGatewayMode = 'gateway-binding' | 'run-gateway';

/**
 * Minimal structural type for the gateway binding returned by env.AI.gateway(id).
 * Matches @cloudflare/tanstack-ai's internal `CloudflareAiGateway` interface exactly,
 * using the DOM `Response` type (not @cloudflare/workers-types Response) to satisfy
 * `createWorkersAiChat`'s `AiGatewayBindingConfig.binding` constraint.
 *
 * Why not use `Ai` from @cloudflare/workers-types directly: its `AiGateway.run`
 * returns `Promise<workers-types/Response>`, which is structurally incompatible
 * with `Promise<DOM/Response>` (workers-types Headers is missing `getSetCookie`).
 * The local structural type sidesteps that mismatch cleanly.
 */
interface CloudflareAiGateway {
  run(request: unknown): Promise<Response>;
}

interface AiBinding {
  gateway(gatewayId: string): CloudflareAiGateway;
  run(model: string, input: Record<string, unknown>, opts?: { gateway?: { id: string; skipCache?: boolean } }): Promise<unknown>;
}

export interface AiGatewayEnv {
  AI: AiBinding;
  AI_GATEWAY_MODE?: AiGatewayMode;
}

// Default model ids — concrete @cf/* ids per CLAUDE.md "Inside a Worker" constraint.
// Dynamic route slugs (dynamic/text_gen etc.) cannot be used here.
export const DEFAULT_CHAT_MODEL = '@cf/google/gemma-4-26b-a4b-it';
export const DEFAULT_IMAGE_MODEL = '@cf/stabilityai/stable-diffusion-xl-base-1.0';
export const DEFAULT_TTS_MODEL = '@cf/deepgram/aura-2-en';
export const DEFAULT_STT_MODEL = '@cf/openai/whisper-large-v3-turbo';
export const DEFAULT_SUMMARIZE_MODEL = '@cf/facebook/bart-large-cnn';

/**
 * Resolve the active mode from env. Defaults to 'run-gateway' — the proven,
 * observability-preserving `env.AI.run('@cf/..', .., { gateway: { id } })` path
 * (byte-for-byte parity with create-tools.ts today; it also preserves the
 * provider error message, which the gateway-binding adapter loses to
 * @tanstack/ai's strip-to-spec middleware). Set `AI_GATEWAY_MODE` to
 * 'gateway-binding' to opt into the @cloudflare/tanstack-ai gateway-binding
 * adapter once it's smoke-verified on the account (see runGatewayChat /
 * runGatewayTts below and the E11 AI Studio spec, Appendix B).
 */
export function resolveMode(env: AiGatewayEnv): AiGatewayMode {
  return env.AI_GATEWAY_MODE === 'gateway-binding' ? 'gateway-binding' : 'run-gateway';
}

/**
 * Returns `env.AI.gateway(GATEWAY_ID)` — the gateway-scoped binding.
 * This is the ONLY accepted binding for createWorkersAiChat; plain env.AI is forbidden.
 */
function gatewayBinding(env: AiGatewayEnv) {
  return env.AI.gateway(GATEWAY_ID);
}

/**
 * Convert raw audio bytes (Uint8Array | ArrayBuffer) to a base64 string.
 * Chunked to avoid blowing the argument stack on `String.fromCharCode(...big)`.
 */
function bytesToBase64(bytes: Uint8Array): string {
  let binary = '';
  const chunk = 0x8000;
  for (let i = 0; i < bytes.length; i += chunk) {
    binary += String.fromCharCode(...bytes.subarray(i, i + chunk));
  }
  return btoa(binary);
}

/**
 * Merge systemPrompts + messages into a single flat array for env.AI.run.
 *
 * Mirrors the official @cloudflare/tanstack-ai `buildOpenAIMessages` ordering:
 * system prompts are prepended as a single `{ role: 'system' }` entry (joined
 * with "\n") before the conversation messages. `SystemPrompt` is
 * `string | { content: string; metadata? }` — we normalise both shapes by
 * extracting `.content` (or using the string directly) before joining.
 */
function buildMessages(
  systemPrompts: Array<SystemPrompt> | undefined,
  messages: Array<ModelMessage>,
): Array<{ role: string; content: string | null | unknown }> {
  const result: Array<{ role: string; content: string | null | unknown }> = [];
  if (systemPrompts && systemPrompts.length > 0) {
    const systemContent = systemPrompts
      .map((sp) => (typeof sp === 'string' ? sp : sp.content))
      .join('\n');
    result.push({ role: 'system', content: systemContent });
  }
  result.push(...(messages as Array<{ role: string; content: string | null | unknown }>));
  return result;
}

/**
 * run-gateway TTS adapter.
 *
 * Mirrors `src/workers/create-tools.ts` byte-for-byte: it calls
 * `env.AI.run('@cf/<model>', { text, speaker, encoding: 'mp3' }, { gateway: { id } })`
 * directly — the only Worker-side invocation proven to work — while still
 * routing through gateway 'x' so cf-aig observability/caching/cost analytics
 * are preserved. This is the de-risking fallback for when the gateway *binding*
 * (`env.AI.gateway('x')`) misbehaves for an activity.
 *
 * `TTSOptions.text` is the source text; `TTSOptions.voice` maps to the Aura
 * `speaker` payload key (matching create-tools.ts). The raw result may be a
 * `Uint8Array`, `ArrayBuffer`, or `Response` — all three are narrowed to bytes
 * and base64-encoded into the `TTSResult.audio` field.
 */
function runGatewayTts(env: AiGatewayEnv, model: string): TTSAdapter {
  return {
    kind: 'tts',
    name: 'run-gateway-tts',
    model,
    '~types': undefined as never,
    async generateSpeech(options: TTSOptions): Promise<TTSResult> {
      const raw = await env.AI.run(
        model,
        { text: options.text, speaker: options.voice, encoding: 'mp3' },
        { gateway: { id: GATEWAY_ID } },
      );
      let bytes: Uint8Array;
      if (raw instanceof Response) {
        bytes = new Uint8Array(await raw.arrayBuffer());
      } else if (raw instanceof Uint8Array) {
        bytes = raw;
      } else if (raw instanceof ArrayBuffer) {
        bytes = new Uint8Array(raw);
      } else if (raw != null && typeof (raw as ReadableStream).getReader === 'function') {
        // @cf/deepgram/aura-2-en may return a ReadableStream of MPEG audio bytes.
        // Wrap it in a Response so we can await arrayBuffer() without draining
        // the reader manually — same pattern the official TTS adapter uses.
        bytes = new Uint8Array(await new Response(raw as ReadableStream).arrayBuffer());
      } else if (raw && typeof raw === 'object' && 'audio' in raw && typeof (raw as { audio: unknown }).audio === 'string') {
        // JSON wrapper { audio: "base64..." } — already encoded, pass through.
        return { id: crypto.randomUUID(), model, audio: (raw as { audio: string }).audio, format: 'mp3', contentType: 'audio/mp3' };
      } else {
        throw new Error('run-gateway TTS: unexpected result shape from env.AI.run');
      }
      return { id: crypto.randomUUID(), model, audio: bytesToBase64(bytes), format: 'mp3', contentType: 'audio/mp3' };
    },
  };
}

/**
 * run-gateway chat adapter.
 *
 * Mirrors `src/workers/create-tools.ts` byte-for-byte: it calls
 * `env.AI.run('@cf/<model>', { messages, max_tokens: 800 }, { gateway: { id } })`
 * directly (the only Worker-side invocation proven to work) and narrows the
 * single completed response the same way create-tools does
 * (`raw.response ?? raw.choices[0].message.content`). Because `env.AI.run`
 * returns one complete (non-streamed) response, the AG-UI lifecycle mirrors
 * the real WorkersAiTextAdapter's *non-streaming* branch exactly:
 *   RUN_STARTED → TEXT_MESSAGE_START → TEXT_MESSAGE_CONTENT(delta) → TEXT_MESSAGE_END → RUN_FINISHED
 * (event field shapes copied from @cloudflare/tanstack-ai's workers-ai adapter.)
 */
function narrowChatText(raw: unknown): string {
  let value: unknown = raw;
  if (typeof value === 'string') {
    try {
      value = JSON.parse(value);
    } catch {
      return raw as string;
    }
  }
  const body = (value ?? {}) as { response?: string; choices?: Array<{ message?: { content?: string } }> };
  return body.response ?? body.choices?.[0]?.message?.content ?? '';
}

function runGatewayChat(env: AiGatewayEnv, model: string): TextAdapter<string, Record<string, never>, [], never> {
  return {
    kind: 'text',
    name: 'run-gateway-chat',
    model,
    '~types': undefined as never,
    async *chatStream(options: TextOptions): AsyncIterable<StreamChunk> {
      const timestamp = Date.now();
      const runId = crypto.randomUUID();
      const messageId = crypto.randomUUID();
      let raw: unknown;
      try {
        raw = await env.AI.run(
          model,
          { messages: buildMessages(options.systemPrompts, options.messages), max_tokens: 800 },
          { gateway: { id: GATEWAY_ID } },
        );
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        yield { type: 'RUN_STARTED', runId, model, timestamp } as StreamChunk;
        yield { type: 'RUN_ERROR', runId, model, timestamp, message: message || 'Unknown error' } as StreamChunk;
        return;
      }
      const text = narrowChatText(raw);
      // Mirror WorkersAiTextAdapter's non-streaming branch event sequence.
      yield { type: 'RUN_STARTED', runId, model, timestamp } as StreamChunk;
      yield { type: 'TEXT_MESSAGE_START', messageId, model, timestamp, role: 'assistant' } as StreamChunk;
      yield { type: 'TEXT_MESSAGE_CONTENT', messageId, model, timestamp, delta: text, content: text } as StreamChunk;
      yield { type: 'TEXT_MESSAGE_END', messageId, model, timestamp } as StreamChunk;
      yield { type: 'RUN_FINISHED', runId, model, timestamp, finishReason: 'stop' } as StreamChunk;
    },
    async structuredOutput(options: StructuredOutputOptions<Record<string, never>>): Promise<StructuredOutputResult<unknown>> {
      // Unlike chatStream (which emits a RUN_ERROR event), structuredOutput lets a
      // rejected env.AI.run propagate to the activity layer — it's a non-streaming
      // Promise contract. Intentional; do not wrap in a try/catch that swallows.
      const raw = await env.AI.run(
        model,
        { messages: buildMessages(options.chatOptions.systemPrompts, options.chatOptions.messages), max_tokens: 800 },
        { gateway: { id: GATEWAY_ID } },
      );
      const rawText = narrowChatText(raw);
      let data: unknown = rawText;
      try {
        data = JSON.parse(rawText);
      } catch {
        /* leave data as the raw text when it isn't valid JSON */
      }
      return { data, rawText };
    },
  };
}

/**
 * Returns a @tanstack/ai text adapter for chat. Transport is selected by
 * `resolveMode(env)`:
 *   - 'run-gateway' (default): custom adapter driving `env.AI.run('@cf/<model>', ..., { gateway })`
 *     directly (the proven path, byte-for-byte parity with create-tools.ts).
 *   - 'gateway-binding': adapter built against `env.AI.gateway(GATEWAY_ID)` (opt-in once verified).
 * Either way the call is gateway-routed — bare `env.AI` (plain binding) is never used.
 */
export function gatewayChat(env: AiGatewayEnv, model: string = DEFAULT_CHAT_MODEL) {
  if (resolveMode(env) === 'run-gateway') return runGatewayChat(env, model);
  return createWorkersAiChat(model, { binding: gatewayBinding(env) });
}

export function gatewayImage(env: AiGatewayEnv, model: string = DEFAULT_IMAGE_MODEL) {
  return createWorkersAiImage(model, { binding: gatewayBinding(env) });
}

export function gatewayTts(env: AiGatewayEnv, model: string = DEFAULT_TTS_MODEL) {
  if (resolveMode(env) === 'run-gateway') return runGatewayTts(env, model);
  return createWorkersAiTts(model, { binding: gatewayBinding(env) });
}

export function gatewayTranscription(env: AiGatewayEnv, model: string = DEFAULT_STT_MODEL) {
  return createWorkersAiTranscription(model, { binding: gatewayBinding(env) });
}

export function gatewaySummarize(env: AiGatewayEnv, model: string = DEFAULT_SUMMARIZE_MODEL) {
  return createWorkersAiSummarize(model, { binding: gatewayBinding(env) });
}
