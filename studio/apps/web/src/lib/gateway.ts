// All LLM/embedding/TTS/image/audio calls go through the Cloudflare AI
// Gateway "dynamic/*" routes. NEVER call providers directly. See
// docs/superpowers/specs/...-design.md §10.

import type { Env } from "../env";

export type DynamicRoute =
  | "dynamic/text_gen"
  | "dynamic/fable_gen"
  | "dynamic/research_gen"
  | "dynamic/ai_embed"
  | "dynamic/audio_gen"
  | "dynamic/stt_gen"
  | "dynamic/image_gen"
  | "dynamic/video_gen";

type ChatMessage = {
  role: "system" | "user" | "assistant" | "tool";
  content: string;
};

type ChatOpts = {
  messages: ChatMessage[];
  route: DynamicRoute;
  temperature?: number;
  maxTokens?: number;
  fetch?: typeof fetch;
};

type ChatResult = {
  text: string;
  tokens_in: number;
  tokens_out: number;
  // biome-ignore lint/suspicious/noExplicitAny: passthrough of provider response
  raw: any;
};

function assertDynamic(route: string): asserts route is DynamicRoute {
  if (!route.startsWith("dynamic/")) {
    throw new Error(
      `gateway: route must be a dynamic/* slug; got "${route}". Direct provider routes are forbidden - see CLAUDE.md.`,
    );
  }
}

async function chatCompletion(
  env: Pick<Env, "AI_GATEWAY_BASE_URL" | "AI_GATEWAY_TOKEN">,
  opts: ChatOpts,
): Promise<ChatResult> {
  assertDynamic(opts.route);

  const f = opts.fetch ?? fetch;
  const url = `${env.AI_GATEWAY_BASE_URL.replace(/\/$/, "")}/chat/completions`;

  const res = await f(url, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "cf-aig-authorization": `Bearer ${env.AI_GATEWAY_TOKEN}`,
      "cf-aig-zdr": "true",
    },
    body: JSON.stringify({
      model: opts.route,
      messages: opts.messages,
      temperature: opts.temperature ?? 0.7,
      max_tokens: opts.maxTokens,
    }),
  });

  if (!res.ok) {
    throw new Error(`gateway ${opts.route}: ${res.status} ${await res.text()}`);
  }

  // biome-ignore lint/suspicious/noExplicitAny: provider JSON shape
  const json = (await res.json()) as any;
  return {
    text: json.choices?.[0]?.message?.content ?? "",
    tokens_in: json.usage?.prompt_tokens ?? 0,
    tokens_out: json.usage?.completion_tokens ?? 0,
    raw: json,
  };
}

async function audioGen(
  env: Pick<Env, "AI_GATEWAY_BASE_URL" | "AI_GATEWAY_TOKEN">,
  opts: {
    input: string;
    voice: string;
    format?: "mp3" | "wav";
    fetch?: typeof fetch;
  },
): Promise<ArrayBuffer> {
  const f = opts.fetch ?? fetch;
  const url = `${env.AI_GATEWAY_BASE_URL.replace(/\/$/, "")}/audio/speech`;
  const res = await f(url, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "cf-aig-authorization": `Bearer ${env.AI_GATEWAY_TOKEN}`,
      "cf-aig-zdr": "true",
    },
    body: JSON.stringify({
      model: "dynamic/audio_gen",
      input: opts.input,
      voice: opts.voice,
      format: opts.format ?? "mp3",
    }),
  });
  if (!res.ok) throw new Error(`gateway audio_gen: ${res.status}`);
  return await res.arrayBuffer();
}

export const gateway = { chatCompletion, audioGen };
