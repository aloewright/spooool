import { describe, expect, it } from "vitest";
import {
  fullBookView,
  manuscriptMarkdown,
  normalizeExportKinds,
} from "../../apps/web/src/workflows/book-export-helpers";

describe("book export workflow helpers", () => {
  it("assembles chapter drafts into a pandoc-friendly manuscript", () => {
    const manuscript = manuscriptMarkdown("My Book", [
      { ordinal: 1, title: "Start", summary: "Opening summary", draft_md: "Draft body" },
      { ordinal: 2, title: "Next", summary: "Fallback summary", draft_md: "" },
    ]);

    expect(manuscript).toContain("% My Book");
    expect(manuscript).toContain("# 1. Start\n\nDraft body");
    expect(manuscript).toContain("# 2. Next\n\nFallback summary");
  });

  it("builds a full book view from drafted chapters and summaries", () => {
    const book = fullBookView("My Book", [
      {
        id: "chapter-1",
        ordinal: 1,
        title: "Start",
        summary: "Opening summary",
        draft_md: "Draft body",
      },
      { ordinal: 2, title: "Next", summary: "Fallback summary", draft_md: "" },
    ]);

    expect(book.title).toBe("My Book");
    expect(book.drafted_chapters).toBe(1);
    expect(book.chapters[0]).toMatchObject({
      id: "chapter-1",
      body_md: "Draft body",
      has_draft: true,
    });
    expect(book.chapters[1]).toMatchObject({ body_md: "Fallback summary", has_draft: false });
    expect(book.total_words).toBeGreaterThan(0);
  });

  it("normalizes selected export formats", () => {
    expect(normalizeExportKinds(["pdf", "epub", "pdf"])).toEqual(["pdf", "epub"]);
    expect(normalizeExportKinds(["bad"])).toEqual(["epub", "pdf", "kpf"]);
  });
});
