// Extrapolates a reusable voice & tone profile from example blog articles
// (links fetched server-side plus uploaded/pasted text). Used by the blog
// compose wizard and as a fallback during blog creation.

import type { Env } from "../../env";
import { gateway } from "../../lib/gateway";

export type BlogVoiceUpload = { name?: string; text: string };

export type BlogVoiceInput = {
  links: string[];
  uploads: BlogVoiceUpload[];
};

const MAX_SAMPLE_CHARS = 8_000;
const MAX_TOTAL_CHARS = 24_000;
const LINK_FETCH_TIMEOUT_MS = 8_000;

export function htmlToText(html: string): string {
  return html
    .replace(/<script[\s\S]*?<\/script>/gi, " ")
    .replace(/<style[\s\S]*?<\/style>/gi, " ")
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/gi, " ")
    .replace(/&amp;/gi, "&")
    .replace(/&lt;/gi, "<")
    .replace(/&gt;/gi, ">")
    .replace(/&#?\w+;/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

async function fetchArticleText(url: string, f: typeof fetch = fetch): Promise<string | null> {
  try {
    const res = await f(url, {
      signal: AbortSignal.timeout(LINK_FETCH_TIMEOUT_MS),
      headers: { Accept: "text/html, text/plain, text/markdown" },
    });
    if (!res.ok) return null;
    const body = await res.text();
    const contentType = res.headers.get("content-type") ?? "";
    const text = contentType.includes("html") ? htmlToText(body) : body.trim();
    return text.length > 0 ? text.slice(0, MAX_SAMPLE_CHARS) : null;
  } catch {
    return null;
  }
}

export async function collectVoiceSamples(
  input: BlogVoiceInput,
  f: typeof fetch = fetch,
): Promise<{ label: string; text: string }[]> {
  const samples: { label: string; text: string }[] = [];
  for (const upload of input.uploads) {
    samples.push({
      label: upload.name?.trim() || "Uploaded article",
      text: upload.text.slice(0, MAX_SAMPLE_CHARS),
    });
  }
  const fetched = await Promise.all(input.links.map((link) => fetchArticleText(link, f)));
  for (const [i, text] of fetched.entries()) {
    if (text) samples.push({ label: input.links[i], text });
  }
  return samples;
}

export async function extrapolateVoiceProfile(
  env: Pick<Env, "AI_GATEWAY_BASE_URL" | "AI_GATEWAY_TOKEN">,
  input: BlogVoiceInput,
  f: typeof fetch = fetch,
): Promise<{ profile_md: string; samples_used: number }> {
  const samples = await collectVoiceSamples(input, f);
  if (samples.length === 0) {
    throw new Error("no readable voice samples — check the links or upload an article");
  }

  let budget = MAX_TOTAL_CHARS;
  const blocks: string[] = [];
  for (const sample of samples) {
    if (budget <= 0) break;
    const text = sample.text.slice(0, budget);
    budget -= text.length;
    blocks.push(`### Sample: ${sample.label}\n\n${text}`);
  }

  const result = await gateway.chatCompletion(env, {
    route: "dynamic/text_gen",
    temperature: 0.4,
    maxTokens: 800,
    messages: [
      {
        role: "system",
        content:
          "You analyze example blog articles and extrapolate a reusable voice & tone profile a ghostwriter could follow. Output markdown with exactly these sections: ## Voice summary (2-3 sentences), ## Tone, ## Sentence & rhythm, ## Vocabulary & diction, ## Formatting habits, ## What this writer avoids. Describe the writing, never the topic. Be specific and concrete; no preamble before the first heading.",
      },
      {
        role: "user",
        content: `Extrapolate the voice & tone profile from these example articles:\n\n${blocks.join("\n\n---\n\n")}`,
      },
    ],
  });

  return { profile_md: result.text.trim(), samples_used: samples.length };
}
