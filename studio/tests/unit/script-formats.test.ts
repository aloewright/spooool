import { describe, expect, it } from "vitest";
import {
  SCRIPT_FORMATS,
  SCRIPT_FORMAT_IDS,
  getScriptFormat,
  planScenesForStructure,
} from "../../apps/web/src/shared/script-formats";

describe("script formats", () => {
  it("exposes all four formats", () => {
    expect(SCRIPT_FORMATS).toHaveLength(4);
    expect(SCRIPT_FORMAT_IDS).toEqual(["feature", "tv-episode", "short-film", "stage-play"]);
  });

  it("applies the documented planning thresholds", () => {
    expect(getScriptFormat("feature")?.minScenes).toBe(8);
    expect(getScriptFormat("tv-episode")?.minScenes).toBe(5);
    expect(getScriptFormat("short-film")?.minScenes).toBe(3);
    expect(getScriptFormat("stage-play")?.minScenes).toBe(6);
  });

  it("curates structures per format", () => {
    for (const format of SCRIPT_FORMATS) {
      expect(format.structures.length).toBeGreaterThanOrEqual(1);
      expect(format.defaultScenes).toBeGreaterThanOrEqual(format.minScenes);
      const structureIds = format.structures.map((s) => s.id);
      expect(new Set(structureIds).size).toBe(structureIds.length);
    }
  });

  it("returns undefined for unknown formats", () => {
    expect(getScriptFormat("radio-drama")).toBeUndefined();
  });

  it("offers the screenwriting frameworks per format", () => {
    // Every format also carries the shared frameworks after its own.
    const sharedStructures = ["hero-journey", "truby-22", "character-arc", "thriller", "sci-fi"];

    const feature = getScriptFormat("feature");
    expect(feature?.structures.map((s) => s.id)).toEqual([
      "three-act",
      "save-the-cat",
      "story-circle",
      ...sharedStructures,
    ]);
    expect(feature?.structures.find((s) => s.id === "three-act")?.beats).toHaveLength(12);
    expect(feature?.structures.find((s) => s.id === "save-the-cat")?.beats).toHaveLength(15);
    expect(feature?.structures.find((s) => s.id === "story-circle")?.beats).toHaveLength(8);
    expect(feature?.structures.find((s) => s.id === "hero-journey")?.beats).toHaveLength(12);
    expect(feature?.structures.find((s) => s.id === "truby-22")?.beats).toHaveLength(22);

    const tv = getScriptFormat("tv-episode");
    expect(tv?.structures.map((s) => s.id)).toEqual(["five-act", "sitcom-ab", ...sharedStructures]);
    expect(tv?.structures.find((s) => s.id === "five-act")?.beats).toHaveLength(7);
    expect(tv?.structures.find((s) => s.id === "sitcom-ab")?.beats).toHaveLength(8);

    const short = getScriptFormat("short-film");
    expect(short?.structures.map((s) => s.id)).toEqual([
      "single-turn",
      "mini-arc",
      ...sharedStructures,
    ]);
    expect(short?.structures.find((s) => s.id === "single-turn")?.beats).toHaveLength(3);
    expect(short?.structures.find((s) => s.id === "mini-arc")?.beats).toHaveLength(5);

    const stage = getScriptFormat("stage-play");
    expect(stage?.structures.map((s) => s.id)).toEqual(["two-act-stage", ...sharedStructures]);
    expect(stage?.structures.find((s) => s.id === "two-act-stage")?.beats).toHaveLength(8);
  });

  describe("planScenesForStructure", () => {
    const feature = getScriptFormat("feature");
    const saveTheCat = feature?.structures.find((s) => s.id === "save-the-cat");
    const storyCircle = feature?.structures.find((s) => s.id === "story-circle");

    it("maps one beat per scene when counts match", () => {
      const plan = planScenesForStructure(saveTheCat, 15);
      expect(plan).toHaveLength(15);
      expect(plan[0].title).toBe("Opening Image");
      expect(plan[14].title).toBe("Final Image");
      expect(plan.every((s) => !s.title.includes("·"))).toBe(true);
    });

    it("groups beats when there are fewer scenes than beats", () => {
      const plan = planScenesForStructure(saveTheCat, 5);
      expect(plan).toHaveLength(5);
      // Every beat is covered exactly once across the groups.
      const titles = plan.flatMap((s) => s.title.split(" · "));
      expect(titles).toHaveLength(15);
      expect(titles[0]).toBe("Opening Image");
      expect(titles[14]).toBe("Final Image");
    });

    it("continues beats when there are more scenes than beats", () => {
      const plan = planScenesForStructure(storyCircle, 12);
      expect(plan).toHaveLength(12);
      expect(plan[0].title).toBe("You");
      expect(plan.some((s) => s.title.endsWith("(continued)"))).toBe(true);
      // The circle still closes on the final beat.
      expect(plan[11].title.startsWith("Change")).toBe(true);
    });

    it("returns untitled slots for unknown structures", () => {
      const plan = planScenesForStructure(undefined, 3);
      expect(plan).toEqual([
        { title: "", summary: "" },
        { title: "", summary: "" },
        { title: "", summary: "" },
      ]);
    });
  });
});
