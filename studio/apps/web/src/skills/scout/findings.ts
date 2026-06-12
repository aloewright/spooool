import type { Env } from "../../env";
import { gateway } from "../../lib/gateway";
import type { MarketDatasetRecord } from "./dataset";

export type ScoutType = "nonfiction" | "fiction";

export type ScoutEvidence = {
  dataset: {
    snapshot_id: string;
    week_iso: string;
    r2_key: string;
    source: string;
  };
  niche: string;
  type: ScoutType;
  input_context?: ScoutContext;
  records: MarketDatasetRecord[];
  source_mix: {
    kdp: number;
    trends: number;
    library: number;
  };
  keyword_counts: { keyword: string; count: number }[];
  opportunity_score: number;
  confidence: "low" | "medium" | "high";
  audience_brief: string;
  positioning_brief: string;
  verdict: {
    status: "ready" | "validate" | "reframe";
    label: string;
    rationale: string;
  };
  concept_brief: {
    audience: string;
    promise: string;
    differentiator: string;
    must_prove: string;
  };
  gaps: string[];
  recommendations: string[];
  validation_steps: string[];
  next_questions: string[];
};

export type ScoutFindingDraft = {
  summary_md: string;
  evidence_json: ScoutEvidence;
};

export type ScoutContext = {
  audience?: string;
  angle?: string;
};

export async function readMarketRecords(
  env: Pick<Env, "R2">,
  r2Key: string,
): Promise<MarketDatasetRecord[]> {
  const object = await env.R2.get(r2Key);
  if (!object) return [];
  return parseMarketRecords(await object.text());
}

export function parseMarketRecords(jsonl: string): MarketDatasetRecord[] {
  return jsonl
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line) => JSON.parse(line) as Partial<MarketDatasetRecord>)
    .map(normalizeRecord)
    .filter((record): record is MarketDatasetRecord => Boolean(record));
}

export async function synthesizeMarketFinding(
  env: Pick<Env, "AI_GATEWAY_BASE_URL" | "AI_GATEWAY_TOKEN">,
  input: {
    niche: string;
    type: ScoutType;
    context?: ScoutContext;
    records: MarketDatasetRecord[];
    dataset: ScoutEvidence["dataset"];
  },
): Promise<ScoutFindingDraft> {
  const evidence = buildEvidence(input);
  const fallback = renderSummary(evidence);

  if (env.AI_GATEWAY_BASE_URL && env.AI_GATEWAY_TOKEN) {
    try {
      const result = await gateway.chatCompletion(env, {
        route: "dynamic/research_gen",
        temperature: 0.2,
        maxTokens: 900,
        messages: [
          {
            role: "system",
            content:
              "Return concise markdown only. Summarize book-market evidence into positioning gaps and next concept moves. Do not invent titles beyond the provided evidence.",
          },
          {
            role: "user",
            content: JSON.stringify({
              niche: input.niche,
              type: input.type,
              evidence: evidence.records,
              context: evidence.input_context,
              verdict: evidence.verdict,
              concept_brief: evidence.concept_brief,
              gaps: evidence.gaps,
              recommendations: evidence.recommendations,
              next_questions: evidence.next_questions,
            }),
          },
        ],
      });
      const summary = result.text.trim();
      if (summary) return { summary_md: summary, evidence_json: evidence };
    } catch (error) {
      console.warn("scout finding synthesis fell back to deterministic summary", error);
    }
  }

  return { summary_md: fallback, evidence_json: evidence };
}

function buildEvidence(input: {
  niche: string;
  type: ScoutType;
  context?: ScoutContext;
  records: MarketDatasetRecord[];
  dataset: ScoutEvidence["dataset"];
}): ScoutEvidence {
  const records = selectRecords(input.records, input.niche);
  const topKeywords = keywordCounts(records).slice(0, 6);
  const sourceMix = countSources(records);
  const sourceSet = new Set(records.map((record) => record.source));
  const opportunityScore = scoreOpportunity(records, topKeywords, sourceMix);
  const confidence = confidenceFor(records, sourceMix);
  const leadingKeywords =
    topKeywords
      .slice(0, 3)
      .map(([keyword]) => keyword)
      .join(", ") || "broad reader outcomes";
  const context = normalizeScoutContext(input.context);
  const audience =
    context.audience ||
    (input.type === "fiction"
      ? `readers looking for ${input.niche}`
      : `readers trying to solve ${input.niche}`);
  const angle =
    context.angle ||
    (input.type === "fiction"
      ? `a familiar ${input.niche} hook with a distinct emotional payoff`
      : `a practical method for ${input.niche}`);
  const readerLanguage =
    input.type === "fiction"
      ? "readers want a familiar hook with a distinct emotional payoff"
      : "readers want a specific outcome with a credible method";
  const verdict = verdictFor(opportunityScore, confidence, sourceMix);
  const conceptBrief = {
    audience,
    promise:
      input.type === "fiction"
        ? `Deliver ${angle} for ${audience}, anchored by ${leadingKeywords}.`
        : `Help ${audience} achieve ${angle} with a named, evidence-backed mechanism.`,
    differentiator: `Own the gap around ${leadingKeywords} by making the market promise more specific than the comparable records.`,
    must_prove:
      confidence === "low"
        ? "Prove that the reader demand is durable outside the current small evidence set."
        : "Prove that the hook is meaningfully different from the strongest comparable titles.",
  };
  const gaps = [
    `${input.type === "fiction" ? "Story" : "Promise"} angles are clustered around ${leadingKeywords}, leaving room for a sharper owned mechanism than "${angle}".`,
    sourceSet.has("library")
      ? "Catalog demand is visible, but the current signals do not show a clear fresh hook."
      : "Library/catalog durability is thin in the current dataset, so validate evergreen demand before scaling.",
    sourceSet.has("trends")
      ? "Search interest is present; package the concept around a specific reader moment rather than the whole category."
      : "Trend signals are sparse; use audience interviews or ads before committing to a narrow promise.",
  ];
  const recommendations = [
    `Lead with a concrete ${input.type === "fiction" ? "reader trope plus emotional payoff" : "reader outcome plus method"} for ${audience}.`,
    "Use the highest-signal keywords in subtitle, description, and first-chapter promise language.",
    "Differentiate the table of contents with a gap-focused chapter that competitors are not explicitly naming.",
  ];
  const validationSteps = [
    "Write three alternate subtitles or loglines that foreground the highest-frequency keyword cluster.",
    "Compare the first ten customer-visible promises against the top comparable titles before outlining.",
    sourceMix.trends > 0
      ? "Test the strongest hook with a search-style headline before drafting."
      : "Run a small audience interview pass because trend support is currently weak.",
  ];
  const nextQuestions = [
    `What is the one-sentence promise for ${audience}?`,
    "Which comparable title will readers recognize, and how is this book visibly different?",
    `What proof, scene, chapter, or case study makes "${conceptBrief.must_prove}" credible?`,
  ];

  return {
    dataset: input.dataset,
    niche: input.niche,
    type: input.type,
    input_context: context,
    records,
    source_mix: sourceMix,
    keyword_counts: topKeywords.map(([keyword, count]) => ({ keyword, count })),
    opportunity_score: opportunityScore,
    confidence,
    audience_brief: `${capitalize(input.niche)}: ${readerLanguage}; target ${audience}; current signals lean on ${leadingKeywords}.`,
    positioning_brief: `Position around ${angle} with a ${input.type === "fiction" ? "distinct story promise" : "named practical mechanism"} that uses ${leadingKeywords} while explicitly resolving one visible gap.`,
    verdict,
    concept_brief: conceptBrief,
    gaps,
    recommendations,
    validation_steps: validationSteps,
    next_questions: nextQuestions,
  };
}

function selectRecords(records: MarketDatasetRecord[], niche: string) {
  const tokens = tokenize(niche);
  const scored = records
    .map((record) => ({
      record,
      score:
        scoreText(record.niche, tokens) * 3 +
        scoreText(record.title, tokens) * 2 +
        scoreText(record.signal, tokens) +
        record.keywords.reduce((sum, keyword) => sum + scoreText(keyword, tokens), 0),
    }))
    .sort((a, b) => b.score - a.score || a.record.rank - b.record.rank);
  const relevant = scored.filter((item) => item.score > 0).map((item) => item.record);
  return (relevant.length ? relevant : scored.map((item) => item.record)).slice(0, 12);
}

function keywordCounts(records: MarketDatasetRecord[]) {
  const counts = new Map<string, number>();
  for (const record of records) {
    for (const keyword of record.keywords) {
      const normalized = keyword.trim().toLowerCase();
      if (normalized.length < 3) continue;
      counts.set(normalized, (counts.get(normalized) ?? 0) + 1);
    }
  }
  return [...counts.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]));
}

function renderSummary(evidence: ScoutEvidence) {
  const titleList = evidence.records
    .slice(0, 5)
    .map((record) => `- ${record.title} (${record.source}, rank ${record.rank}): ${record.signal}`)
    .join("\n");
  return [
    `## Scout read: ${evidence.niche}`,
    "",
    `Opportunity score: **${evidence.opportunity_score}/100** · Confidence: **${evidence.confidence}**`,
    "",
    `Verdict: **${evidence.verdict.label}** — ${evidence.verdict.rationale}`,
    "",
    evidence.audience_brief,
    "",
    evidence.positioning_brief,
    "",
    "### Concept brief",
    `- Audience: ${evidence.concept_brief.audience}`,
    `- Promise: ${evidence.concept_brief.promise}`,
    `- Differentiator: ${evidence.concept_brief.differentiator}`,
    `- Must prove: ${evidence.concept_brief.must_prove}`,
    "",
    "### Trending titles and signals",
    titleList,
    "",
    "### Gap analysis",
    ...evidence.gaps.map((gap) => `- ${gap}`),
    "",
    "### Concept moves",
    ...evidence.recommendations.map((item) => `- ${item}`),
    "",
    "### Validation steps",
    ...evidence.validation_steps.map((item) => `- ${item}`),
    "",
    "### Questions before outline",
    ...evidence.next_questions.map((item) => `- ${item}`),
  ].join("\n");
}

function tokenize(text: string) {
  return text
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter((token) => token.length > 2 && !STOPWORDS.has(token));
}

function scoreText(text: string, tokens: string[]) {
  const haystack = text.toLowerCase();
  return tokens.reduce((score, token) => score + (haystack.includes(token) ? 1 : 0), 0);
}

function countSources(records: MarketDatasetRecord[]) {
  return records.reduce(
    (mix, record) => {
      mix[record.source] += 1;
      return mix;
    },
    { kdp: 0, trends: 0, library: 0 },
  );
}

function scoreOpportunity(
  records: MarketDatasetRecord[],
  topKeywords: [string, number][],
  sourceMix: ScoutEvidence["source_mix"],
) {
  const sourceBreadth = [sourceMix.kdp, sourceMix.trends, sourceMix.library].filter(Boolean).length;
  const keywordDepth = topKeywords.reduce((sum, [, count]) => sum + Math.min(count, 3), 0);
  const recordDepth = Math.min(records.length, 12);
  return Math.max(20, Math.min(95, recordDepth * 4 + sourceBreadth * 12 + keywordDepth * 3));
}

function confidenceFor(records: MarketDatasetRecord[], sourceMix: ScoutEvidence["source_mix"]) {
  const sourceBreadth = [sourceMix.kdp, sourceMix.trends, sourceMix.library].filter(Boolean).length;
  if (records.length >= 9 && sourceBreadth >= 3) return "high";
  if (records.length >= 5 && sourceBreadth >= 2) return "medium";
  return "low";
}

function verdictFor(
  opportunityScore: number,
  confidence: ScoutEvidence["confidence"],
  sourceMix: ScoutEvidence["source_mix"],
): ScoutEvidence["verdict"] {
  const sourceBreadth = [sourceMix.kdp, sourceMix.trends, sourceMix.library].filter(Boolean).length;
  if (opportunityScore >= 72 && confidence !== "low") {
    return {
      status: "ready",
      label: "Ready to shape",
      rationale:
        "Demand is broad enough to move into concept shaping while keeping the hook narrow.",
    };
  }
  if (opportunityScore >= 55 || sourceBreadth >= 2) {
    return {
      status: "validate",
      label: "Validate the hook",
      rationale:
        "Signals are usable, but the concept needs a sharper proof point before outlining.",
    };
  }
  return {
    status: "reframe",
    label: "Reframe before outlining",
    rationale:
      "The current evidence is thin, so broaden the reader promise or test a clearer angle.",
  };
}

function normalizeScoutContext(context?: ScoutContext): ScoutContext {
  return {
    audience: cleanContextField(context?.audience),
    angle: cleanContextField(context?.angle),
  };
}

function cleanContextField(value: unknown) {
  if (typeof value !== "string") return undefined;
  const trimmed = value.trim().replace(/\s+/g, " ");
  return trimmed ? trimmed.slice(0, 240) : undefined;
}

function capitalize(text: string) {
  return text ? `${text[0].toUpperCase()}${text.slice(1)}` : text;
}

function normalizeRecord(record: Partial<MarketDatasetRecord>): MarketDatasetRecord | null {
  if (!record.title || !record.niche) return null;
  const source =
    record.source === "kdp" || record.source === "trends" || record.source === "library"
      ? record.source
      : "kdp";
  return {
    source,
    niche: String(record.niche),
    title: String(record.title),
    author: record.author ? String(record.author) : "Market aggregate",
    rank: Number.isFinite(record.rank) ? Number(record.rank) : 999,
    signal: record.signal ? String(record.signal) : "market signal",
    keywords: Array.isArray(record.keywords) ? record.keywords.slice(0, 8).map(String) : [],
    observed_at: record.observed_at ? String(record.observed_at) : new Date(0).toISOString(),
  };
}

const STOPWORDS = new Set([
  "about",
  "after",
  "and",
  "are",
  "book",
  "for",
  "from",
  "how",
  "into",
  "readers",
  "that",
  "the",
  "their",
  "this",
  "with",
]);
