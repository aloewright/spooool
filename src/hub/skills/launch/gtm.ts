import type { Env } from "../../env";
import { gateway } from "../../lib/gateway";
import type { PublisherSeoPack } from "../publisher/seo";
import type { ScoutEvidence } from "../scout/findings";

export type GtmBriefContent = {
  title: string;
  subtitle: string;
  positioning: string;
  comp_titles: string[];
  launch_checklist: string[];
  preorder_copy: {
    headline: string;
    body: string;
  };
  email_sequence: {
    subject: string;
    body: string;
  }[];
  ad_headlines: string[];
  arc_reader_brief: string;
  milestones: {
    week_1: string[];
    month_1: string[];
    month_3: string[];
  };
};

export type GtmBriefResult = {
  content_json: GtmBriefContent;
  brief_md: string;
  llm_response: {
    route: "dynamic/research_gen" | "deterministic/local";
    tokens_in: number;
    tokens_out: number;
  };
};

export type GtmBriefInput = {
  project: {
    title: string;
    type: "nonfiction" | "fiction";
    genre?: string | null;
  };
  publisherPack: PublisherSeoPack;
  marketFindings: {
    summary_md: string;
    evidence_json: ScoutEvidence;
  }[];
};

export async function synthesizeGtmBrief(
  env: Pick<Env, "AI_GATEWAY_BASE_URL" | "AI_GATEWAY_TOKEN">,
  input: GtmBriefInput,
): Promise<GtmBriefResult> {
  if (env.AI_GATEWAY_BASE_URL && env.AI_GATEWAY_TOKEN) {
    try {
      const result = await gateway.chatCompletion(env, {
        route: "dynamic/research_gen",
        temperature: 0.25,
        maxTokens: 2200,
        messages: [
          {
            role: "system",
            content:
              "Return strict JSON only. Build a practical go-to-market handoff brief for a finished book. Ground every recommendation in the provided publisher pack and market evidence.",
          },
          {
            role: "user",
            content: JSON.stringify({
              shape:
                "title, subtitle, positioning, comp_titles[], launch_checklist[], preorder_copy{headline,body}, email_sequence[{subject,body}], ad_headlines[], arc_reader_brief, milestones{week_1[],month_1[],month_3[]}",
              project: input.project,
              publisher_pack: input.publisherPack,
              market_findings: input.marketFindings,
            }),
          },
        ],
      });
      const parsed = normalizeBrief(parseJson(result.text), input);
      return {
        content_json: parsed,
        brief_md: renderGtmBriefMarkdown(parsed),
        llm_response: {
          route: "dynamic/research_gen",
          tokens_in: result.tokens_in,
          tokens_out: result.tokens_out,
        },
      };
    } catch (error) {
      console.warn("gtm brief synthesis fell back to deterministic brief", error);
    }
  }

  const content = deterministicBrief(input);
  return {
    content_json: content,
    brief_md: renderGtmBriefMarkdown(content),
    llm_response: {
      route: "deterministic/local",
      tokens_in: countWords(JSON.stringify(input)),
      tokens_out: countWords(JSON.stringify(content)),
    },
  };
}

export function deterministicBrief(input: GtmBriefInput): GtmBriefContent {
  const pack = input.publisherPack;
  const evidence = input.marketFindings[0]?.evidence_json;
  const compTitles =
    evidence?.records.slice(0, 5).map((record) => record.title) ??
    pack.keywords.slice(0, 5).map((keyword) => `${pack.title}: ${keyword}`);
  const strongestGap =
    evidence?.gaps[0] ??
    "The book needs a launch angle that connects its promise to a specific reader moment.";

  return {
    ...deterministicSeed(input),
    comp_titles: compTitles,
    positioning: `${pack.title} should launch around a clear promise: ${pack.subtitle || strongestGap}`,
    preorder_copy: {
      headline: pack.subtitle || `Pre-order ${pack.title}`,
      body: stripHtml(pack.description_html).slice(0, 900),
    },
  };
}

export function renderGtmBriefMarkdown(content: GtmBriefContent) {
  return [
    `# ${content.title} Launch Handoff`,
    "",
    content.subtitle ? `**Subtitle:** ${content.subtitle}` : "",
    "",
    "## Positioning",
    content.positioning,
    "",
    "## Comp Titles",
    ...content.comp_titles.map((item) => `- ${item}`),
    "",
    "## Launch Checklist",
    ...content.launch_checklist.map((item) => `- [ ] ${item}`),
    "",
    "## Pre-order Copy",
    `### ${content.preorder_copy.headline}`,
    content.preorder_copy.body,
    "",
    "## Email Sequence",
    ...content.email_sequence.flatMap((email, index) => [
      `### Email ${index + 1}: ${email.subject}`,
      email.body,
      "",
    ]),
    "## Ad Headlines",
    ...content.ad_headlines.map((item) => `- ${item}`),
    "",
    "## ARC Reader Brief",
    content.arc_reader_brief,
    "",
    "## Milestones",
    "### Week 1",
    ...content.milestones.week_1.map((item) => `- ${item}`),
    "### Month 1",
    ...content.milestones.month_1.map((item) => `- ${item}`),
    "### Month 3",
    ...content.milestones.month_3.map((item) => `- ${item}`),
  ]
    .filter((line) => line !== "")
    .join("\n\n");
}

function normalizeBrief(value: Partial<GtmBriefContent>, input: GtmBriefInput): GtmBriefContent {
  const fallback = deterministicSeed(input);
  return {
    title: stringOr(value.title, fallback.title),
    subtitle: stringOr(value.subtitle, fallback.subtitle),
    positioning: stringOr(value.positioning, fallback.positioning),
    comp_titles: strings(value.comp_titles, fallback.comp_titles).slice(0, 8),
    launch_checklist: strings(value.launch_checklist, fallback.launch_checklist).slice(0, 12),
    preorder_copy: {
      headline: stringOr(value.preorder_copy?.headline, fallback.preorder_copy.headline),
      body: stringOr(value.preorder_copy?.body, fallback.preorder_copy.body),
    },
    email_sequence: normalizeEmails(value.email_sequence, fallback.email_sequence),
    ad_headlines: strings(value.ad_headlines, fallback.ad_headlines).slice(0, 10),
    arc_reader_brief: stringOr(value.arc_reader_brief, fallback.arc_reader_brief),
    milestones: {
      week_1: strings(value.milestones?.week_1, fallback.milestones.week_1).slice(0, 8),
      month_1: strings(value.milestones?.month_1, fallback.milestones.month_1).slice(0, 8),
      month_3: strings(value.milestones?.month_3, fallback.milestones.month_3).slice(0, 8),
    },
  };
}

function deterministicSeed(input: GtmBriefInput): GtmBriefContent {
  const pack = input.publisherPack;
  return {
    title: pack.title || input.project.title,
    subtitle: pack.subtitle,
    positioning: `${pack.title || input.project.title} should launch around a specific reader promise.`,
    comp_titles: pack.keywords.slice(0, 5).map((keyword) => `${pack.title}: ${keyword}`),
    launch_checklist: [
      "Finalize metadata, description, and category keywords.",
      "Recruit 25-50 ARC readers from adjacent audiences.",
      "Publish pre-order copy across owned channels.",
      "Prepare week-one review requests and launch-day email.",
      "Track conversion by keyword, headline, and audience segment.",
    ],
    preorder_copy: {
      headline: pack.subtitle || `Pre-order ${pack.title || input.project.title}`,
      body: stripHtml(pack.description_html).slice(0, 900),
    },
    email_sequence: [
      {
        subject: `Why I wrote ${pack.title || input.project.title}`,
        body: `Open with the reader problem, then frame ${pack.title || input.project.title} as the practical next step.`,
      },
      {
        subject: "A first look inside the book",
        body: "Share the strongest chapter promise, one excerpt, and a pre-order call to action.",
      },
      {
        subject: `${pack.title || input.project.title} is live`,
        body: "Ask readers to buy, review, and forward the book to one person who needs it.",
      },
    ],
    ad_headlines: [
      pack.subtitle || `Read ${pack.title || input.project.title}`,
      `${pack.title || input.project.title}: a sharper way forward`,
      `For readers searching ${pack.keywords[0] ?? input.project.title}`,
      `Turn the core promise of ${pack.title || input.project.title} into action`,
      `A practical launch pick for ${pack.keywords[1] ?? "focused readers"}`,
    ],
    arc_reader_brief: `Invite ARC readers who care about ${pack.keywords.slice(0, 3).join(", ")}. Ask them to read within two weeks, note one memorable promise, and leave an honest review at launch.`,
    milestones: {
      week_1: [
        "Confirm retail metadata and landing page tracking.",
        "Send ARC onboarding and first excerpt email.",
        "Test three ad headlines with small-budget traffic.",
      ],
      month_1: [
        "Ship launch email sequence and review request.",
        "Compare sales and clicks by keyword angle.",
        "Refresh description copy around the highest-converting promise.",
      ],
      month_3: [
        "Decide whether to expand ads, audiobook promotion, or a companion offer.",
        "Package reader feedback into long-tail content.",
        "Plan the next book or lead magnet from conversion data.",
      ],
    },
  };
}

function normalizeEmails(
  value: GtmBriefContent["email_sequence"] | undefined,
  fallback: GtmBriefContent["email_sequence"],
) {
  if (!Array.isArray(value)) return fallback;
  const rows = value
    .map((item) => ({
      subject: stringOr(item?.subject, ""),
      body: stringOr(item?.body, ""),
    }))
    .filter((item) => item.subject && item.body)
    .slice(0, 6);
  return rows.length ? rows : fallback;
}

function parseJson(text: string) {
  try {
    return JSON.parse(
      text
        .replace(/^```(?:json)?\s*/i, "")
        .replace(/```$/i, "")
        .trim(),
    ) as Partial<GtmBriefContent>;
  } catch {
    return {};
  }
}

function strings(value: unknown, fallback: string[]) {
  return Array.isArray(value)
    ? value.filter((item): item is string => typeof item === "string")
    : fallback;
}

function stringOr(value: unknown, fallback: string) {
  return typeof value === "string" && value.trim() ? value.trim() : fallback;
}

function stripHtml(value: string) {
  return value
    .replace(/<[^>]+>/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function countWords(value: string) {
  return value.split(/\s+/).filter(Boolean).length;
}
