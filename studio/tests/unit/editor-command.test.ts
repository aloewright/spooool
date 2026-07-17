import { describe, expect, it, vi } from "vitest";
import { editorAiRequestSchema } from "../../apps/web/src/shared/editor-ai";
import {
  buildEditorCommandMessages,
  runEditorCommand,
} from "../../apps/web/src/skills/editor-command";

const chapterContext = {
  kind: "chapter" as const,
  projectTitle: "Quiet Operator",
  projectType: "nonfiction" as const,
  chapterTitle: "The Cost of Staying Stuck",
  chapterSummary: "Show why reactive work remains expensive.",
  voiceProfile: { cadence: "short and direct" },
};

describe("editor AI request contract", () => {
  it("requires rewrite instructions and non-write target content", () => {
    expect(() =>
      editorAiRequestSchema.parse({
        resource_kind: "chapter",
        resource_id: "chapter-1",
        command: "rewrite",
        scope: "selection",
        target_md: "Selected prose.",
        context_md: "Selected prose in context.",
      }),
    ).toThrow();

    expect(() =>
      editorAiRequestSchema.parse({
        resource_kind: "blog-post",
        resource_id: "post-1",
        command: "proofread",
        scope: "document",
        target_md: "",
        context_md: "",
      }),
    ).toThrow();
  });

  it("permits an empty whole-document write", () => {
    expect(
      editorAiRequestSchema.parse({
        resource_kind: "script-scene",
        resource_id: "scene-1",
        command: "write",
        scope: "document",
        target_md: "",
        context_md: "",
      }).command,
    ).toBe("write");
  });
});

describe("editor command prompts", () => {
  it("requests only replacement prose for a selection", () => {
    const messages = buildEditorCommandMessages({
      request: {
        resource_kind: "chapter",
        resource_id: "chapter-1",
        command: "proofread",
        scope: "selection",
        target_md: "This are selected.",
        context_md: "Before. This are selected. After.",
      },
      context: chapterContext,
    });
    expect(messages[1].content).toContain(
      "Return only replacement Markdown for the selected passage",
    );
    expect(messages[1].content).toContain("This are selected.");
    expect(messages[1].content).toContain("Quiet Operator");
  });

  it.each([
    ["write", "dynamic/text_gen"],
    ["proofread", "dynamic/text_gen"],
    ["rewrite", "dynamic/text_gen"],
    ["cite", "dynamic/research_gen"],
  ] as const)("routes %s through %s", async (command, route) => {
    const fetchMock = vi.fn().mockResolvedValue(
      new Response(
        JSON.stringify({
          choices: [{ message: { content: "Replacement prose." } }],
          usage: { prompt_tokens: 12, completion_tokens: 4 },
        }),
      ),
    );
    const request = {
      resource_kind: "chapter" as const,
      resource_id: "chapter-1",
      command,
      scope: "document" as const,
      target_md: command === "write" ? "" : "Draft prose.",
      context_md: "Draft prose.",
      instructions: command === "rewrite" ? "Make it clearer." : undefined,
    };
    const result = await runEditorCommand(
      { AI_GATEWAY_BASE_URL: "https://gateway.test", AI_GATEWAY_TOKEN: "token" },
      { request, context: chapterContext },
      { fetch: fetchMock },
    );
    const body = JSON.parse(fetchMock.mock.calls[0][1].body);
    expect(body.model).toBe(route);
    expect(result.markdown).toBe("Replacement prose.");
    expect(result.llm_response.route).toBe(route);
  });

  it("rejects missing configuration and empty fenced output", async () => {
    await expect(
      runEditorCommand(
        { AI_GATEWAY_BASE_URL: "", AI_GATEWAY_TOKEN: "" },
        {
          request: {
            resource_kind: "chapter",
            resource_id: "chapter-1",
            command: "proofread",
            scope: "document",
            target_md: "Draft prose.",
            context_md: "Draft prose.",
          },
          context: chapterContext,
        },
      ),
    ).rejects.toThrow("AI Gateway is not configured");
  });
});
