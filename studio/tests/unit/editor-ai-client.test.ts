import { describe, expect, it } from "vitest";
import {
  EDITOR_AI_MENU_ITEMS,
  flattenReplacementBlocks,
  needsInstructions,
} from "../../apps/web/client/components/editor-ai/commands";

describe("editor AI client helpers", () => {
  it("matches the local blog command order and instruction rules", () => {
    expect(EDITOR_AI_MENU_ITEMS.map((item) => item.command)).toEqual([
      "write",
      "proofread",
      "cite",
      "rewrite",
    ]);
    expect(EDITOR_AI_MENU_ITEMS.map((item) => item.title)).toEqual([
      "Write",
      "Proofread",
      "Cite",
      "Rewrite",
    ]);
    expect(needsInstructions("write")).toBe("optional");
    expect(needsInstructions("rewrite")).toBe("required");
    expect(needsInstructions("proofread")).toBe("none");
    expect(needsInstructions("cite")).toBe("none");
  });

  it("flattens parsed replacement blocks while retaining links and hard breaks", () => {
    expect(
      flattenReplacementBlocks([
        { type: "paragraph", content: [{ type: "text", text: "First", styles: {} }] },
        {
          type: "paragraph",
          content: [{ type: "link", href: "https://example.com", content: "Source" }],
        },
      ]),
    ).toEqual([
      { type: "text", text: "First", styles: {} },
      "\n",
      { type: "link", href: "https://example.com", content: "Source" },
    ]);
  });

  it("rejects block content that cannot be inserted safely as inline content", () => {
    expect(() =>
      flattenReplacementBlocks([
        {
          type: "table",
          content: {
            type: "tableContent",
            rows: [],
          },
        },
      ]),
    ).toThrow("unsupported block content");
  });

  it("rejects nested replacement blocks instead of silently dropping their children", () => {
    expect(() =>
      flattenReplacementBlocks([
        {
          type: "bulletListItem",
          content: [{ type: "text", text: "Parent", styles: {} }],
          children: [
            {
              type: "bulletListItem",
              content: [{ type: "text", text: "Child", styles: {} }],
            },
          ],
        },
      ]),
    ).toThrow("nested block content");
  });
});
