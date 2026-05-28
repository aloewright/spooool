//
// Tool implementations for the prompt-to-video agent (sub-project #4).
// Each tool wraps an AI Gateway dynamic route per CLAUDE.md's "never call
// providers directly" rule. Pure of side effects beyond the explicit
// network / R2 calls so unit tests can mock fetch.

import type { StoryTemplate, VoiceProfile } from './create/templates/types';
import { submitRenderJob as defaultSubmitRenderJob, type RenderEnv, type SubmitRenderJobInput } from './render';

/**
 * Kept for backward-compat with downstream env intersections
 * (`CreateEnv`, `ComposerAgentEnv`, `CMAEnv` all extend it). The fields
 * are no longer consumed by `chatComplete` — text gen routes through
 * the Workers AI binding instead — but other code paths may still
 * reference these worker secrets, so we keep the type around.
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
const TEXT_GATEWAY_SLUG = 'spooool';

interface ChatCompletionResponse {
  choices?: Array<{ message?: { content?: string } }>;
}

/**
 * Invoke a dynamic-route chat completion via the Workers AI binding's
 * gateway proxy. Equivalent shape to the official Cloudflare doc snippet
 * (https://developers.cloudflare.com/ai-gateway/features/dynamic-routing/).
 *
 * Why this and not `fetch()` to the compat URL: a Worker hitting the
 * gateway via fetch() gets rejected pre-route with error 2019
 * ("Compatibility..."). The binding's `.gateway(slug).run({provider:'compat',...})`
 * path is the documented work-around and is what dynamic routes are
 * designed to be called with from inside a Worker.
 */
async function chatComplete(
  args: { route: 'dynamic/text'; messages: Array<{ role: 'system' | 'user'; content: string }>; env: AIBindingEnv },
  retries: number,
): Promise<string> {
  let lastErr: unknown = null;
  for (let attempt = 0; attempt <= retries; attempt++) {
    try {
      const raw = await args.env.AI.gateway(TEXT_GATEWAY_SLUG).run({
        provider: 'compat',
        endpoint: 'chat/completions',
        query: { model: args.route, messages: args.messages },
      });
      // The binding either returns the parsed JSON directly or a Response.
      let body: ChatCompletionResponse;
      if (raw && typeof raw === 'object' && 'json' in raw && typeof (raw as Response).json === 'function') {
        body = await (raw as Response).json() as ChatCompletionResponse;
      } else {
        body = raw as ChatCompletionResponse;
      }
      const content = body?.choices?.[0]?.message?.content;
      if (typeof content === 'string') return content;
      lastErr = new Error('AI Gateway returned no message content');
    } catch (err) {
      lastErr = err instanceof Error ? err : new Error(String(err));
      const msg = lastErr instanceof Error ? lastErr.message : '';
      // Non-retryable: 4xx / route-shape errors look like client mistakes.
      if (/\b4\d\d\b/.test(msg) || /invalid|bad request|not found/i.test(msg)) break;
    }
    if (attempt < retries) await new Promise((r) => setTimeout(r, 500 * (attempt + 1)));
  }
  throw lastErr instanceof Error ? lastErr : new Error('AI Gateway call failed');
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
  let content: string;
  try {
    content = await chatComplete({ route: 'dynamic/text', messages, env: args.env }, 2);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    throw new Error(`Script generation failed: ${msg}`);
  }
  return { script: content.slice(0, MAX_SCRIPT_CHARS) };
}

export async function planScenes(args: {
  script: string;
  template: StoryTemplate;
  env: AIBindingEnv;
}): Promise<{ scenes: SceneSpec[] }> {
  const messages = [
    {
      role: 'system' as const,
      content:
        `${args.template.systemPromptFragment}\nReturn ONLY a JSON object of shape { "scenes": [{ "type": "title"|"beat"|"outro", "durationFrames": number, "text": string, "subtitle"?: string }] }. Use 30fps; the sum of durationFrames must be 1800-2700 (60-90 seconds). Do NOT include any commentary outside the JSON.`,
    },
    { role: 'user' as const, content: `Script:\n${args.script}\n\nTemplate scene plan hints:\n${JSON.stringify(args.template.scenePlan)}` },
  ];

  const parseOrThrow = (raw: string): SceneSpec[] => {
    const parsed = JSON.parse(raw) as { scenes?: unknown };
    if (!parsed || !Array.isArray(parsed.scenes)) throw new Error('missing scenes array');
    return parsed.scenes.slice(0, MAX_SCENES).map((s) => {
      const obj = s as { type?: unknown; durationFrames?: unknown; text?: unknown; subtitle?: unknown };
      if (obj.type !== 'title' && obj.type !== 'beat' && obj.type !== 'outro') throw new Error('bad scene type');
      if (typeof obj.durationFrames !== 'number' || !Number.isFinite(obj.durationFrames)) throw new Error('bad durationFrames');
      if (typeof obj.text !== 'string') throw new Error('bad text');
      return {
        type: obj.type,
        durationFrames: Math.max(1, Math.floor(obj.durationFrames)),
        text: obj.text,
        subtitle: typeof obj.subtitle === 'string' ? obj.subtitle : undefined,
      };
    });
  };

  const tryOnce = async (): Promise<SceneSpec[]> => {
    const raw = await chatComplete({ route: 'dynamic/text', messages, env: args.env }, 0);
    return parseOrThrow(raw);
  };

  try {
    return { scenes: await tryOnce() };
  } catch {
    try {
      return { scenes: await tryOnce() };
    } catch (secondErr) {
      const msg = secondErr instanceof Error ? secondErr.message : String(secondErr);
      throw new Error(`Scene plan invalid: ${msg}`);
    }
  }
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
 * call that invokes a Cloudflare AI Gateway dynamic route from inside a
 * Worker. We use this for draft_script + plan_scenes (text gen via the
 * `dynamic/text` route on the `spooool` gateway). Auth is handled by the
 * binding itself; no CF_AIG_TOKEN required.
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
const TTS_MODEL = '@cf/deepgram/aura-2-en';
const TTS_GATEWAY_ID = 'spooool';

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

  let raw: ArrayBuffer | Uint8Array | Response;
  try {
    raw = await args.env.AI.run(
      TTS_MODEL,
      { text: args.script, speaker: auraSpeaker(args.voice.profile), encoding: 'mp3' },
      { gateway: { id: TTS_GATEWAY_ID } },
    );
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    if (isContentPolicyMsg(msg)) {
      console.error('[create-tools] tts content-policy refusal', msg.slice(0, 500));
      throw new Error('Generation failed, please try rephrasing your prompt.');
    }
    throw new Error(`TTS synthesis failed: ${msg.slice(0, 200)}`);
  }

  // Aura returns audio as a Uint8Array; future SDK revs may wrap in a
  // Response — handle both.
  let audioBytes: ArrayBuffer;
  if (raw instanceof Response) {
    audioBytes = await raw.arrayBuffer();
  } else if (raw instanceof Uint8Array) {
    audioBytes = raw.buffer.slice(raw.byteOffset, raw.byteOffset + raw.byteLength) as ArrayBuffer;
  } else {
    audioBytes = raw;
  }
  if (!audioBytes || audioBytes.byteLength === 0) {
    throw new Error('TTS synthesis returned empty audio');
  }

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
