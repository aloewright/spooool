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

import { createWorkersAiChat } from '@cloudflare/tanstack-ai/adapters/workers-ai';

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
 * Resolve the active mode from env. Defaults to 'gateway-binding'.
 * The 'run-gateway' branch (added in a later task) uses env.AI.run with
 * gateway opts for the full request flow.
 */
export function resolveMode(env: AiGatewayEnv): AiGatewayMode {
  return env.AI_GATEWAY_MODE === 'run-gateway' ? 'run-gateway' : 'gateway-binding';
}

/**
 * Returns `env.AI.gateway(GATEWAY_ID)` — the gateway-scoped binding.
 * This is the ONLY accepted binding for createWorkersAiChat; plain env.AI is forbidden.
 */
function gatewayBinding(env: AiGatewayEnv) {
  return env.AI.gateway(GATEWAY_ID);
}

/**
 * Build a @tanstack/ai chat adapter routed through AI Gateway binding.
 *
 * Uses gateway-binding mode only. The 'run-gateway' branch is added in a later task.
 * Always passes `env.AI.gateway(GATEWAY_ID)` — never bare `env.AI` — to preserve
 * cf-aig observability.
 */
export function gatewayChat(env: AiGatewayEnv, model: string = DEFAULT_CHAT_MODEL) {
  return createWorkersAiChat(model, { binding: gatewayBinding(env) });
}
