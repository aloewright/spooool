import { describe, expect, it } from "vitest";
import {
  BLOG_FORMATS,
  BLOG_FORMAT_IDS,
  getBlogFormat,
  planPostsForStructure,
} from "../../apps/web/src/shared/blog-formats";

describe("blog formats", () => {
  it("exposes all ten formats", () => {
    expect(BLOG_FORMATS).toHaveLength(10);
    expect(BLOG_FORMAT_IDS).toEqual([
      "serialized-fiction",
      "how-to",
      "opinion",
      "case-study",
      "listicle",
      "interview",
      "newsletter",
      "transcript",
      "interactive",
      "meta",
    ]);
  });

  it("applies the documented planning thresholds", () => {
    expect(getBlogFormat("how-to")?.minPosts).toBe(1);
    expect(getBlogFormat("interactive")?.minPosts).toBe(3);
    expect(getBlogFormat("serialized-fiction")?.minPosts).toBe(8);
  });

  it("curates audiences and structures per format", () => {
    for (const format of BLOG_FORMATS) {
      expect(format.audienceOptions.length).toBeGreaterThanOrEqual(4);
      expect(format.structures.length).toBeGreaterThanOrEqual(2);
      expect(format.defaultPosts).toBeGreaterThanOrEqual(format.minPosts);
      const structureIds = format.structures.map((s) => s.id);
      expect(new Set(structureIds).size).toBe(structureIds.length);
    }
  });

  it("returns undefined for unknown formats", () => {
    expect(getBlogFormat("zine")).toBeUndefined();
  });

  it("offers the book fiction frameworks for serialized fiction", () => {
    const fiction = getBlogFormat("serialized-fiction");
    expect(fiction?.structures.map((s) => s.id)).toEqual([
      "hero-journey",
      "truby-22",
      "character-arc",
      "thriller",
      "sci-fi",
    ]);
    expect(fiction?.structures.find((s) => s.id === "hero-journey")?.beats).toHaveLength(12);
    expect(fiction?.structures.find((s) => s.id === "truby-22")?.beats).toHaveLength(22);
    expect(fiction?.structures.find((s) => s.id === "character-arc")?.beats).toHaveLength(12);
    expect(fiction?.structures.find((s) => s.id === "thriller")?.beats).toHaveLength(15);
    expect(fiction?.structures.find((s) => s.id === "sci-fi")?.beats).toHaveLength(14);
  });

  describe("planPostsForStructure", () => {
    const fiction = getBlogFormat("serialized-fiction");
    const hero = fiction?.structures.find((s) => s.id === "hero-journey");
    const truby = fiction?.structures.find((s) => s.id === "truby-22");

    it("maps one beat per post when counts match", () => {
      const plan = planPostsForStructure(hero, 12);
      expect(plan).toHaveLength(12);
      expect(plan[0].title).toBe("Ordinary World");
      expect(plan[11].title).toBe("Return");
      expect(plan.every((p) => !p.title.includes("·"))).toBe(true);
    });

    it("groups beats when there are fewer posts than beats", () => {
      const plan = planPostsForStructure(truby, 8);
      expect(plan).toHaveLength(8);
      // Every beat is covered exactly once across the groups.
      const titles = plan.flatMap((p) => p.title.split(" · "));
      expect(titles).toHaveLength(22);
      expect(titles[0]).toBe("Need and weakness");
      expect(titles[21]).toBe("Afterimage");
    });

    it("continues beats when there are more posts than beats", () => {
      const plan = planPostsForStructure(hero, 20);
      expect(plan).toHaveLength(20);
      expect(plan[0].title).toBe("Ordinary World");
      expect(plan.some((p) => p.title.endsWith("(continued)"))).toBe(true);
      // The arc still ends at the final beat.
      expect(plan[19].title.startsWith("Return")).toBe(true);
    });

    it("returns untitled slots for structures without beats", () => {
      const howTo = getBlogFormat("how-to")?.structures[0];
      const plan = planPostsForStructure(howTo, 3);
      expect(plan).toEqual([
        { title: "", summary: "" },
        { title: "", summary: "" },
        { title: "", summary: "" },
      ]);
    });
  });
});
