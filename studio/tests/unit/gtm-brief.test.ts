import { describe, expect, it } from "vitest";
import { renderGtmBriefMarkdown, synthesizeGtmBrief } from "../../apps/web/src/skills/launch/gtm";

const input = {
  project: { title: "Quiet Operator", type: "nonfiction" as const, genre: "productivity" },
  publisherPack: {
    title: "Quiet Operator",
    subtitle: "A calmer system for focused work",
    series_name: "",
    description_html: "<p>A practical guide for focused work.</p>",
    keywords: [
      "productivity book",
      "focused work system",
      "calm operating model",
      "time management guide",
      "better work habits",
      "practical self improvement",
      "personal productivity",
    ],
    bisac: [
      "BUSINESS & ECONOMICS / Personal Success",
      "SELF-HELP / Self-Management / Time Management",
    ],
  },
  marketFindings: [
    {
      summary_md: "Market signal",
      evidence_json: {
        dataset: {
          snapshot_id: "snapshot-1",
          week_iso: "2026-W18",
          r2_key: "datasets/2026-W18/raw.jsonl",
          source: "test",
        },
        niche: "productivity systems",
        type: "nonfiction" as const,
        records: [
          {
            source: "kdp" as const,
            niche: "productivity systems",
            title: "Bestseller pattern: productivity systems",
            author: "Market aggregate",
            rank: 1,
            signal: "promise-led positioning",
            keywords: ["productivity", "systems"],
            observed_at: "2026-04-30T00:00:00.000Z",
          },
        ],
        gaps: ["Promise angles need a sharper owned mechanism."],
        recommendations: ["Lead with a concrete reader outcome."],
      },
    },
  ],
};

describe("gtm brief", () => {
  it("creates a deterministic launch handoff with required sections", async () => {
    const result = await synthesizeGtmBrief(
      { AI_GATEWAY_BASE_URL: undefined, AI_GATEWAY_TOKEN: undefined },
      input,
    );

    expect(result.content_json.launch_checklist.length).toBeGreaterThan(3);
    expect(result.content_json.email_sequence).toHaveLength(3);
    expect(result.content_json.milestones.week_1.length).toBeGreaterThan(0);
    expect(result.brief_md).toContain("# Quiet Operator Launch Handoff");
    expect(result.brief_md).toContain("## ARC Reader Brief");
  });

  it("renders markdown from handoff JSON", () => {
    const markdown = renderGtmBriefMarkdown({
      ...input.marketFindings[0].evidence_json,
      title: "Quiet Operator",
      subtitle: "A calmer system for focused work",
      positioning: "Positioning",
      comp_titles: ["Comp A"],
      launch_checklist: ["Do one thing"],
      preorder_copy: { headline: "Pre-order", body: "Body" },
      email_sequence: [{ subject: "Subject", body: "Email body" }],
      ad_headlines: ["Headline"],
      arc_reader_brief: "ARC brief",
      milestones: { week_1: ["W1"], month_1: ["M1"], month_3: ["M3"] },
    });

    expect(markdown).toContain("## Launch Checklist");
    expect(markdown).toContain("- [ ] Do one thing");
  });
});
