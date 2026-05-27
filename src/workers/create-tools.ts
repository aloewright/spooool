//
// Tool implementations for the prompt-to-video agent (sub-project #4).
// Each tool wraps an AI Gateway dynamic route per CLAUDE.md's "never call
// providers directly" rule. Pure of side effects beyond the explicit
// network / R2 calls so unit tests can mock fetch.

import type { StoryTemplate, VoiceProfile } from './create/templates/types';

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

function gatewayUrl(env: AIGatewayEnv): string {
  return `https://gateway.ai.cloudflare.com/v1/${env.CF_ACCOUNT_ID}/${env.CF_GATEWAY_ID}/compat/chat/completions`;
}

function gatewayHeaders(env: AIGatewayEnv): Record<string, string> {
  return {
    'content-type': 'application/json',
    'cf-aig-authorization': `Bearer ${env.CF_AIG_TOKEN}`,
    'cf-aig-zdr': 'true',
  };
}

async function chatComplete(
  args: { route: 'dynamic/text_gen' | 'dynamic/research_gen'; messages: Array<{ role: 'system' | 'user'; content: string }>; env: AIGatewayEnv },
  retries: number,
): Promise<string> {
  let lastErr: unknown = null;
  for (let attempt = 0; attempt <= retries; attempt++) {
    const res = await fetch(gatewayUrl(args.env), {
      method: 'POST',
      headers: gatewayHeaders(args.env),
      body: JSON.stringify({ model: args.route, messages: args.messages }),
    });
    if (res.ok) {
      const body = (await res.json()) as { choices?: Array<{ message?: { content?: string } }> };
      const content = body.choices?.[0]?.message?.content;
      if (typeof content === 'string') return content;
      lastErr = new Error('AI Gateway returned no message content');
    } else {
      lastErr = new Error(`AI Gateway ${res.status}`);
      if (res.status < 500) break; // don't retry 4xx
    }
    if (attempt < retries) await new Promise((r) => setTimeout(r, 500 * (attempt + 1)));
  }
  throw lastErr instanceof Error ? lastErr : new Error('AI Gateway call failed');
}

export async function draftScript(args: {
  template: StoryTemplate;
  answers: Record<string, string>;
  env: AIGatewayEnv;
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
    content = await chatComplete({ route: 'dynamic/text_gen', messages, env: args.env }, 2);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    throw new Error(`Script generation failed: ${msg}`);
  }
  return { script: content.slice(0, MAX_SCRIPT_CHARS) };
}

export async function planScenes(args: {
  script: string;
  template: StoryTemplate;
  env: AIGatewayEnv;
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
    const raw = await chatComplete({ route: 'dynamic/text_gen', messages, env: args.env }, 0);
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

const MAX_TTS_CHARS = 2000;

function audioRouteUrl(env: AIGatewayEnv): string {
  return `https://gateway.ai.cloudflare.com/v1/${env.CF_ACCOUNT_ID}/${env.CF_GATEWAY_ID}/compat/audio/speech`;
}

function isContentPolicyResponse(body: string): boolean {
  return /content[_ ]policy|safety/i.test(body);
}

export async function synthesizeTts(args: {
  script: string;
  voice: { profile: VoiceProfile; pacingWpm: number };
  jobId: string;
  env: AIGatewayEnv & R2BindingEnv;
}): Promise<{ r2Key: string; durationMs: number }> {
  if (args.script.length > MAX_TTS_CHARS) throw new Error('script too long for TTS');

  const payload = {
    model: 'dynamic/audio_gen',
    voice: args.voice.profile,
    input: args.script,
    response_format: 'mp3',
  };

  let res: Response | null = null;
  let lastErr: string = '';
  for (let attempt = 0; attempt <= 1; attempt++) {
    res = await fetch(audioRouteUrl(args.env), {
      method: 'POST',
      headers: gatewayHeaders(args.env),
      body: JSON.stringify(payload),
    });
    if (res.ok && res.headers.get('content-type')?.includes('audio')) break;
    const text = await res.clone().text().catch(() => '');
    lastErr = text;
    if (res.status >= 400 && res.status < 500) {
      if (isContentPolicyResponse(text)) {
        console.error('[create-tools] tts content-policy refusal', text.slice(0, 500));
        throw new Error('Generation failed, please try rephrasing your prompt.');
      }
      break; // other 4xx — don't retry
    }
    if (attempt < 1) await new Promise((r) => setTimeout(r, 500));
  }

  if (!res || !res.ok || !res.headers.get('content-type')?.includes('audio')) {
    throw new Error(`TTS synthesis failed: ${lastErr.slice(0, 200)}`);
  }

  const audioBytes = await res.arrayBuffer();
  const r2Key = `recorder/tts/${args.jobId}.mp3`;

  // Upload with 3x exponential backoff.
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

  // Estimate duration from script length + pacing (we don't decode the mp3 here;
  // the renderer will use the actual audio file length).
  const words = args.script.trim().split(/\s+/).length;
  const durationMs = Math.round((words / args.voice.pacingWpm) * 60_000);

  return { r2Key, durationMs };
}
