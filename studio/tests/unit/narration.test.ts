import { describe, expect, it } from "vitest";
import {
  buildNarrationScript,
  normalizeNarrationText,
} from "../../apps/web/src/skills/publisher/narration";

describe("narration script", () => {
  it("normalizes markdown and expands common abbreviations", () => {
    expect(normalizeNarrationText("## Chapter\nDr. Smith met **Mr. Jones**.")).toBe(
      "Chapter Doctor Smith met Mister Jones.",
    );
  });

  it("builds bounded SSML chunks and an audition sample", () => {
    const script = buildNarrationScript([
      {
        title: "Opening",
        summary: "A short summary.",
        draft_md: `"Start here," she said. ${"This sentence continues. ".repeat(260)}`,
      },
    ]);

    expect(script.chunks.length).toBeGreaterThan(1);
    expect(script.chunks.every((chunk) => chunk.ssml.length <= 4500)).toBe(true);
    expect(script.chunks[0].ssml).toContain("<speak>");
    expect(script.chunks[0].ssml).toContain("<emphasis");
    expect(script.sampleText.length).toBeLessThanOrEqual(900);
  });
});
