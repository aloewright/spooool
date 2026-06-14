import { describe, expect, it } from "vitest";
import { normalizePostPilotGuide } from "../../apps/web/src/skills/voices";

describe("voice helpers", () => {
  it("normalizes Post Pilot guide variants", () => {
    const guide = normalizePostPilotGuide("twain", {
      guide: {
        title: "Mark Twain",
        styleGuide: "Use plain words and sly reversals.",
        exemplars: [{ text: "The river talked first. I listened second." }],
        profileJson: { vocabulary: "Plainspoken" },
      },
    });

    expect(guide.name).toBe("Mark Twain");
    expect(guide.slug).toBe("twain");
    expect(guide.profile_md).toContain("sly reversals");
    expect(guide.profile_json.vocabulary).toBe("Plainspoken");
    expect(guide.exemplars).toEqual(["The river talked first. I listened second."]);
  });
});
