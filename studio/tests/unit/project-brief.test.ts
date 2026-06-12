import { describe, expect, it } from "vitest";
import { buildProjectBriefPrompt } from "../../apps/web/src/shared/project-brief";

describe("buildProjectBriefPrompt", () => {
  it("includes every compose answer when present", () => {
    const brief = buildProjectBriefPrompt({
      title: "My Book",
      type: "nonfiction",
      genre: "Self-Help, Business",
      logline: "A calm operating model for focused work.",
      audience_json: ["Business readers", "Adults"],
      voice_styles_json: ["Conversational", "Witty & sharp"],
    });
    expect(brief).toContain("- Title: My Book");
    expect(brief).toContain("- Type: nonfiction");
    expect(brief).toContain("- Genre: Self-Help, Business");
    expect(brief).toContain("- Logline: A calm operating model for focused work.");
    expect(brief).toContain("- Audience: Business readers, Adults");
    expect(brief).toContain("- Voice & tone: Conversational, Witty & sharp");
  });

  it("omits empty answers instead of rendering blank rows", () => {
    const brief = buildProjectBriefPrompt({
      title: "Untitled",
      type: "fiction",
      genre: null,
      logline: "  ",
      audience_json: [],
      voice_styles_json: undefined,
    });
    expect(brief).toContain("- Title: Untitled");
    expect(brief).toContain("- Type: fiction");
    expect(brief).not.toContain("Genre:");
    expect(brief).not.toContain("Logline:");
    expect(brief).not.toContain("Audience:");
    expect(brief).not.toContain("Voice & tone:");
  });

  it("ignores malformed json values from the database", () => {
    const brief = buildProjectBriefPrompt({
      title: "T",
      type: "fiction",
      audience_json: { not: "an array" },
      voice_styles_json: ["ok", 42, "", "fine"],
    });
    expect(brief).not.toContain("Audience:");
    expect(brief).toContain("- Voice & tone: ok, fine");
  });
});
