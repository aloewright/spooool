import type { Env } from "../../env";
import { gateway } from "../../lib/gateway";

export type SeoChapter = {
  title: string;
  summary: string;
  draft_md?: string;
};

export type SeoSynthesisInput = {
  title: string;
  type: "nonfiction" | "fiction";
  genre?: string | null;
  chapters: SeoChapter[];
};

export type PublisherSeoPack = {
  title: string;
  subtitle: string;
  series_name: string;
  description_html: string;
  keywords: string[];
  bisac: string[];
};

export type PublisherSeoResult = {
  pack: PublisherSeoPack;
  llm_response: {
    route: "dynamic/text_gen" | "deterministic/local";
    tokens_in: number;
    tokens_out: number;
  };
};

const BISAC_NONFICTION = [
  "BUSINESS & ECONOMICS / Personal Success",
  "SELF-HELP / Personal Growth / Success",
  "SELF-HELP / Self-Management / Time Management",
  "BUSINESS & ECONOMICS / Skills",
  "PSYCHOLOGY / Creative Ability",
];

const BISAC_FICTION = [
  "FICTION / Literary",
  "FICTION / Coming of Age",
  "FICTION / Psychological",
  "FICTION / Action & Adventure",
  "FICTION / Women",
];

export async function synthesizePublisherSeo(
  env: Pick<Env, "AI_GATEWAY_BASE_URL" | "AI_GATEWAY_TOKEN">,
  input: SeoSynthesisInput,
): Promise<PublisherSeoResult> {
  if (!env.AI_GATEWAY_BASE_URL || !env.AI_GATEWAY_TOKEN) {
    return deterministicSeo(input);
  }

  const result = await gateway.chatCompletion(env, {
    route: "dynamic/text_gen",
    temperature: 0.35,
    maxTokens: 1600,
    messages: [
      {
        role: "system",
        content:
          "You create Kindle Direct Publishing metadata. Return strict JSON only, with no markdown fences or commentary.",
      },
      {
        role: "user",
        content: [
          "Return JSON with keys: title, subtitle, series_name, description_html, keywords, bisac.",
          "Rules: exactly 7 keywords, each <= 50 characters; exactly 2 BISAC category strings; description_html <= 4000 characters and only uses <p>, <strong>, <em>, <ul>, <li>, and <br>; subtitle should be an Amazon-ready benefit line; series_name is empty string unless the manuscript clearly belongs to a series.",
          `Project: ${input.title}`,
          `Type: ${input.type}`,
          input.genre ? `Genre: ${input.genre}` : "",
          `Manuscript evidence:\n${manuscriptDigest(input)}`,
        ]
          .filter(Boolean)
          .join("\n\n"),
      },
    ],
  });

  const parsed = parseJsonObject(result.text);
  const fallback = deterministicSeo(input).pack;
  return {
    pack: normalizePack(
      {
        title: stringOr(parsed.title, fallback.title),
        subtitle: stringOr(parsed.subtitle, fallback.subtitle),
        series_name: stringOr(parsed.series_name, fallback.series_name),
        description_html: stringOr(parsed.description_html, fallback.description_html),
        keywords: arrayOfStrings(parsed.keywords, fallback.keywords),
        bisac: arrayOfStrings(parsed.bisac, fallback.bisac),
      },
      input,
    ),
    llm_response: {
      route: "dynamic/text_gen",
      tokens_in: result.tokens_in,
      tokens_out: result.tokens_out,
    },
  };
}

export function deterministicSeo(input: SeoSynthesisInput): PublisherSeoResult {
  const chapterSignal = input.chapters
    .slice(0, 5)
    .map((chapter) => chapter.title)
    .filter(Boolean)
    .join(", ");
  const promise =
    input.type === "fiction"
      ? `A character-rich ${input.genre ?? "novel"} shaped by ${chapterSignal || "high-stakes turns"}.`
      : `A practical guide to ${input.genre ?? "better work"} with concrete operating shifts.`;
  const keywords = keywordCandidates(input, chapterSignal);
  const bisacSource = input.type === "fiction" ? BISAC_FICTION : BISAC_NONFICTION;
  const pack = normalizePack(
    {
      title: input.title,
      subtitle:
        input.type === "fiction"
          ? `A compelling ${input.genre ?? "story"} of pressure, choice, and change`
          : "A practical system for turning pressure into focused progress",
      series_name: "",
      description_html: `<p><strong>${escapeHtml(input.title)}</strong> ${escapeHtml(promise)}</p><p>This publisher-ready edition highlights the core promise, reader outcome, and market positioning for a finished manuscript.</p><ul><li>Clear reader transformation</li><li>Search-friendly sales language</li><li>Metadata aligned to the book's strongest chapters</li></ul>`,
      keywords,
      bisac: bisacSource.slice(0, 2),
    },
    input,
  );

  return {
    pack,
    llm_response: {
      route: "deterministic/local",
      tokens_in: countWords(manuscriptDigest(input)),
      tokens_out: countWords(JSON.stringify(pack)),
    },
  };
}

export function validatePublisherSeoPack(pack: PublisherSeoPack) {
  const errors: string[] = [];
  if (!pack.title.trim()) errors.push("Title is required.");
  if (pack.subtitle.length > 200) errors.push("Subtitle must be 200 characters or fewer.");
  if (pack.series_name.length > 200) errors.push("Series name must be 200 characters or fewer.");
  if (pack.description_html.length > 4000)
    errors.push("Description must be 4000 characters or fewer.");
  if (pack.keywords.length !== 7) errors.push("Exactly 7 keywords are required.");
  for (const keyword of pack.keywords) {
    if (!keyword.trim()) errors.push("Keywords cannot be blank.");
    if (keyword.length > 50) errors.push(`Keyword "${keyword}" must be 50 characters or fewer.`);
  }
  if (pack.bisac.length !== 2) errors.push("Exactly 2 BISAC categories are required.");
  for (const category of pack.bisac) {
    if (!category.includes(" / ")) errors.push(`BISAC category "${category}" is too vague.`);
  }
  return errors;
}

export function normalizePack(
  input: PublisherSeoPack,
  context: SeoSynthesisInput,
): PublisherSeoPack {
  const fallback = context.type === "fiction" ? BISAC_FICTION : BISAC_NONFICTION;
  const keywords = [...new Set(input.keywords.map(cleanPlainText).filter(Boolean))]
    .map((keyword) => truncate(keyword, 50))
    .slice(0, 7);
  for (const candidate of keywordCandidates(context, "")) {
    if (keywords.length >= 7) break;
    if (!keywords.includes(candidate)) keywords.push(candidate);
  }

  const bisac = [
    ...new Set(input.bisac.map(cleanPlainText).filter((category) => category.includes(" / "))),
  ]
    .map((category) => truncate(category, 120))
    .slice(0, 2);
  for (const candidate of fallback) {
    if (bisac.length >= 2) break;
    if (!bisac.includes(candidate)) bisac.push(candidate);
  }

  return {
    title: truncate(cleanPlainText(input.title) || context.title, 200),
    subtitle: truncate(cleanPlainText(input.subtitle), 200),
    series_name: truncate(cleanPlainText(input.series_name), 200),
    description_html: truncate(sanitizeDescription(input.description_html), 4000),
    keywords,
    bisac,
  };
}

function manuscriptDigest(input: SeoSynthesisInput) {
  return input.chapters
    .slice(0, 18)
    .map((chapter) =>
      [
        `Chapter: ${chapter.title}`,
        chapter.summary ? `Summary: ${chapter.summary}` : "",
        chapter.draft_md ? `Draft excerpt: ${chapter.draft_md.slice(0, 1000)}` : "",
      ]
        .filter(Boolean)
        .join("\n"),
    )
    .join("\n\n")
    .slice(0, 14_000);
}

function keywordCandidates(input: SeoSynthesisInput, chapterSignal: string) {
  const base =
    input.type === "fiction"
      ? [
          `${input.genre ?? "literary"} novel`,
          "character driven fiction",
          "emotional page turner",
          "book club fiction",
          "psychological drama",
          "coming of age story",
          "compelling modern fiction",
        ]
      : [
          `${input.genre ?? "productivity"} book`,
          "practical self improvement",
          "focused work system",
          "time management guide",
          "personal productivity",
          "calm operating model",
          "better work habits",
        ];
  const chapterTerms = chapterSignal
    .split(/[,:\-]/)
    .map((term) => cleanPlainText(term).toLowerCase())
    .filter((term) => term.length >= 4 && term.length <= 50);
  return [...chapterTerms, ...base].map((term) => truncate(term, 50)).slice(0, 12);
}

function parseJsonObject(text: string) {
  try {
    return JSON.parse(
      text
        .replace(/^```(?:json)?\s*/i, "")
        .replace(/```$/i, "")
        .trim(),
    ) as Record<string, unknown>;
  } catch {
    return {};
  }
}

function arrayOfStrings(value: unknown, fallback: string[]) {
  return Array.isArray(value)
    ? value.filter((item): item is string => typeof item === "string")
    : fallback;
}

function stringOr(value: unknown, fallback: string) {
  return typeof value === "string" ? value : fallback;
}

function cleanPlainText(value: string) {
  return value.replace(/\s+/g, " ").trim();
}

function sanitizeDescription(value: string) {
  const cleaned = value
    .replace(/<(?!\/?(p|strong|em|ul|li|br)\b)[^>]*>/gi, "")
    .replace(/\son\w+="[^"]*"/gi, "")
    .trim();
  if (cleaned) return cleaned;
  return "<p>Publisher description pending.</p>";
}

function truncate(value: string, max: number) {
  return value.length <= max ? value : value.slice(0, max).trimEnd();
}

function escapeHtml(value: string) {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function countWords(text: string) {
  return text.trim().match(/\b[\w'-]+\b/g)?.length ?? 0;
}
