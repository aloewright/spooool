import type { Env } from "../env";
import { gateway } from "../lib/gateway";

export type VoiceProfile = {
  summary: string;
  sentenceLength: string;
  vocabulary: string;
  signatureMoves: string[];
  avoid: string[];
};

export type PostPilotGuide = {
  name: string;
  slug: string;
  profile_md: string;
  profile_json: VoiceProfile;
  exemplars: string[];
};

export function countWords(text: string) {
  const words = text.trim().match(/\b[\w'-]+\b/g);
  return words?.length ?? 0;
}

export function normalizePostPilotGuide(slug: string, data: unknown): PostPilotGuide {
  const record = data && typeof data === "object" ? (data as Record<string, unknown>) : {};
  const guide =
    record.guide && typeof record.guide === "object"
      ? (record.guide as Record<string, unknown>)
      : record;
  const name = stringValue(guide.name) || stringValue(guide.title) || slug;
  const profileMd =
    stringValue(guide.profile_md) ||
    stringValue(guide.profileMd) ||
    stringValue(guide.style_guide) ||
    stringValue(guide.styleGuide) ||
    stringValue(guide.prompt) ||
    "";
  const exemplars = arrayOfStrings(guide.exemplars)
    .concat(arrayOfStrings(guide.samples))
    .concat(arrayOfStrings(guide.examples));
  const profileJson = jsonObject(guide.profile_json) || jsonObject(guide.profileJson);

  return {
    name,
    slug,
    profile_md: profileMd || basicVoiceProfile(exemplars.join("\n\n")).profile_md,
    profile_json: {
      ...basicVoiceProfile(exemplars.join("\n\n")).profile_json,
      ...(profileJson ?? {}),
      summary: stringValue(profileJson?.summary) || `Imported Post Pilot voice guide for ${name}.`,
    },
    exemplars,
  };
}

export function basicVoiceProfile(sampleText: string): {
  profile_md: string;
  profile_json: VoiceProfile;
} {
  const wordCount = countWords(sampleText);
  const sentences = sampleText.match(/[^.!?]+[.!?]+/g) ?? [];
  const avgSentenceWords = sentences.length ? Math.round(wordCount / sentences.length) : 0;
  const profile: VoiceProfile = {
    summary:
      wordCount >= 1500
        ? "Draft voice profile generated from the supplied corpus."
        : "Add at least 1,500 words to unlock AI-assisted voice distillation.",
    sentenceLength: avgSentenceWords
      ? `Average sentence length is about ${avgSentenceWords} words.`
      : "Sentence length has not been measured yet.",
    vocabulary: "Vocabulary register will be refined as more samples are added.",
    signatureMoves: [],
    avoid: [],
  };

  return {
    profile_md: [
      "## Voice profile",
      "",
      profile.summary,
      "",
      `- Corpus words: ${wordCount}`,
      `- ${profile.sentenceLength}`,
      `- ${profile.vocabulary}`,
    ].join("\n"),
    profile_json: profile,
  };
}

export async function synthesizeVoiceProfile(
  env: Env,
  sampleText: string,
): Promise<{ profile_md: string; profile_json: VoiceProfile }> {
  if (countWords(sampleText) < 1500 || !env.AI_GATEWAY_BASE_URL || !env.AI_GATEWAY_TOKEN) {
    return basicVoiceProfile(sampleText);
  }

  const result = await gateway.chatCompletion(env, {
    route: "dynamic/text_gen",
    temperature: 0.3,
    maxTokens: 1600,
    messages: [
      {
        role: "system",
        content:
          "You distill author voice samples for a book-writing product. Return concise markdown followed by strict JSON in a fenced json block.",
      },
      {
        role: "user",
        content: `Distill this writing sample into:
1. profile_md: a practical style guide
2. profile_json with keys summary, sentenceLength, vocabulary, signatureMoves, avoid

Sample:
${sampleText.slice(0, 24_000)}`,
      },
    ],
  });

  const jsonMatch = result.text.match(/```json\s*([\s\S]*?)```/);
  const parsed = jsonMatch ? JSON.parse(jsonMatch[1]) : null;
  if (parsed?.profile_json && parsed?.profile_md) {
    return parsed;
  }

  return {
    profile_md: result.text.trim(),
    profile_json: {
      ...basicVoiceProfile(sampleText).profile_json,
      summary: "AI-assisted voice profile generated from the supplied corpus.",
    },
  };
}

function stringValue(value: unknown) {
  return typeof value === "string" ? value.trim() : "";
}

function arrayOfStrings(value: unknown) {
  if (!Array.isArray(value)) return [];
  return value
    .map((item) => {
      if (typeof item === "string") return item.trim();
      if (item && typeof item === "object") {
        const record = item as Record<string, unknown>;
        return (
          stringValue(record.text) || stringValue(record.content) || stringValue(record.excerpt)
        );
      }
      return "";
    })
    .filter(Boolean);
}

function jsonObject(value: unknown) {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Partial<VoiceProfile>)
    : null;
}
