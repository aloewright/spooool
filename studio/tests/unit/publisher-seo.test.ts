import { describe, expect, it } from "vitest";
import {
  deterministicSeo,
  normalizePack,
  validatePublisherSeoPack,
} from "../../apps/web/src/skills/publisher/seo";

describe("publisher SEO synthesis", () => {
  it("returns KDP-shaped deterministic metadata within limits", () => {
    const result = deterministicSeo({
      title: "Quiet Operator",
      type: "nonfiction",
      genre: "productivity",
      chapters: [
        {
          title: "The Cost of Staying Stuck",
          summary: "Reactive work drains focus and momentum.",
          draft_md: "The reader needs a calmer operating model.",
        },
      ],
    });

    expect(result.pack.keywords).toHaveLength(7);
    expect(result.pack.keywords.every((keyword) => keyword.length <= 50)).toBe(true);
    expect(result.pack.bisac).toHaveLength(2);
    expect(result.pack.description_html.length).toBeLessThanOrEqual(4000);
    expect(validatePublisherSeoPack(result.pack)).toEqual([]);
  });

  it("normalizes noisy pack data before persistence", () => {
    const pack = normalizePack(
      {
        title: "  Quiet Operator  ",
        subtitle: "x".repeat(260),
        series_name: "  ",
        description_html: '<script>alert("x")</script><p>Good copy</p>',
        keywords: ["focused work", "focused work", "x".repeat(80)],
        bisac: ["BUSINESS & ECONOMICS / Skills"],
      },
      {
        title: "Quiet Operator",
        type: "nonfiction",
        genre: "productivity",
        chapters: [],
      },
    );

    expect(pack.title).toBe("Quiet Operator");
    expect(pack.subtitle.length).toBe(200);
    expect(pack.description_html).not.toContain("<script>");
    expect(pack.keywords).toHaveLength(7);
    expect(pack.bisac).toHaveLength(2);
    expect(validatePublisherSeoPack(pack)).toEqual([]);
  });

  it("falls back from vague BISAC codes to full category paths", () => {
    const pack = normalizePack(
      {
        title: "Quiet Operator",
        subtitle: "A calmer system for focused work",
        series_name: "",
        description_html: "<p>Body</p>",
        keywords: ["one", "two", "three", "four", "five", "six", "seven"],
        bisac: ["BUS006000", "BUS006030"],
      },
      {
        title: "Quiet Operator",
        type: "nonfiction",
        genre: "productivity",
        chapters: [],
      },
    );

    expect(pack.bisac).toEqual([
      "BUSINESS & ECONOMICS / Personal Success",
      "SELF-HELP / Personal Growth / Success",
    ]);
    expect(validatePublisherSeoPack(pack)).toEqual([]);
  });
});
