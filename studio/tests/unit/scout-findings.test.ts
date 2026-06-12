import { describe, expect, it } from "vitest";
import {
  parseMarketRecords,
  synthesizeMarketFinding,
} from "../../apps/web/src/skills/scout/findings";

describe("scout findings", () => {
  it("parses JSONL records and builds deterministic evidence", async () => {
    const records = parseMarketRecords(
      [
        JSON.stringify({
          source: "kdp",
          niche: "cozy fantasy mysteries",
          title: "Moonlit Bookshop Murder",
          author: "Market aggregate",
          rank: 1,
          signal: "bestseller pattern around low-stakes mystery with magic",
          keywords: ["cozy", "fantasy", "mystery"],
          observed_at: "2026-04-30T00:00:00.000Z",
        }),
        JSON.stringify({
          source: "trends",
          niche: "cozy fantasy mysteries",
          title: "Trend signal: magical amateur sleuths",
          author: "Market aggregate",
          rank: 2,
          signal: "search interest around whimsical clues",
          keywords: ["sleuth", "magic", "bookshop"],
          observed_at: "2026-04-30T00:00:00.000Z",
        }),
      ].join("\n"),
    );

    const result = await synthesizeMarketFinding(
      { AI_GATEWAY_BASE_URL: undefined, AI_GATEWAY_TOKEN: undefined },
      {
        niche: "cozy fantasy mysteries",
        type: "fiction",
        context: {
          audience: "cozy readers who want low-stakes magic",
          angle: "a magical bookshop mystery with found-family warmth",
        },
        records,
        dataset: {
          snapshot_id: "snapshot-1",
          week_iso: "2026-W18",
          r2_key: "datasets/2026-W18/raw.jsonl",
          source: "test",
        },
      },
    );

    expect(result.summary_md).toContain("Scout read: cozy fantasy mysteries");
    expect(result.evidence_json.records).toHaveLength(2);
    expect(result.evidence_json.opportunity_score).toBeGreaterThan(20);
    expect(result.evidence_json.confidence).toBe("low");
    expect(result.evidence_json.source_mix).toEqual({ kdp: 1, trends: 1, library: 0 });
    expect(result.evidence_json.keyword_counts[0]).toEqual({ keyword: "bookshop", count: 1 });
    expect(result.evidence_json.audience_brief).toContain("Cozy fantasy mysteries");
    expect(result.evidence_json.audience_brief).toContain("cozy readers");
    expect(result.evidence_json.positioning_brief).toContain("distinct story promise");
    expect(result.evidence_json.positioning_brief).toContain("magical bookshop mystery");
    expect(result.evidence_json.verdict.label).toBe("Validate the hook");
    expect(result.evidence_json.concept_brief.audience).toBe(
      "cozy readers who want low-stakes magic",
    );
    expect(result.evidence_json.concept_brief.promise).toContain("magical bookshop mystery");
    expect(result.evidence_json.gaps).toHaveLength(3);
    expect(result.evidence_json.recommendations[0]).toContain("reader trope");
    expect(result.evidence_json.validation_steps).toHaveLength(3);
    expect(result.evidence_json.next_questions).toHaveLength(3);
  });
});
