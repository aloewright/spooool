import { describe, expect, it, vi } from "vitest";
import { draftSection, reviseInlineText } from "../../apps/web/src/skills/writer";

const input = {
  projectTitle: "Quiet Operator",
  projectType: "nonfiction" as const,
  chapterTitle: "The Cost of Staying Stuck",
  chapterSummary: "Show the reader why reactive work stays expensive.",
  kind: "exposition",
  prompt: "Explain the old pattern with a concrete example.",
};

describe("writer section drafting", () => {
  it("returns a deterministic local draft when gateway credentials are absent", async () => {
    // biome-ignore lint/suspicious/noExplicitAny: minimal env stub for unit test
    const result = await draftSection({} as any, input);

    expect(result.markdown).toContain("concrete moment");
    expect(result.llm_response.route).toBe("deterministic/local");
  });

  it("routes section drafting through dynamic/text_gen when gateway is configured", async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      new Response(
        JSON.stringify({
          choices: [{ message: { content: "## Draft\n\nGateway generated section." } }],
          usage: { prompt_tokens: 12, completion_tokens: 8 },
        }),
      ),
    );
    vi.stubGlobal("fetch", fetchMock);

    const result = await draftSection(
      {
        AI_GATEWAY_BASE_URL: "https://gateway.example/compat",
        AI_GATEWAY_TOKEN: "tok",
      },
      input,
    );

    expect(result.markdown).toContain("Gateway generated section");
    expect(result.llm_response.route).toBe("dynamic/text_gen");
    const body = JSON.parse(fetchMock.mock.calls[0][1].body);
    expect(body.model).toBe("dynamic/text_gen");
    expect(body.messages[1].content).toContain("Section kind: exposition");

    vi.unstubAllGlobals();
  });

  it("tells gateway drafting to continue from existing chapter prose", async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      new Response(
        JSON.stringify({
          choices: [{ message: { content: "## Continuation\n\nThe next scene continues." } }],
          usage: { prompt_tokens: 20, completion_tokens: 8 },
        }),
      ),
    );
    vi.stubGlobal("fetch", fetchMock);

    await draftSection(
      {
        AI_GATEWAY_BASE_URL: "https://gateway.example/compat",
        AI_GATEWAY_TOKEN: "tok",
      },
      {
        ...input,
        currentChapterDraft: "Amaya entered NovaTech and met Zeta in orientation.",
      },
    );

    const body = JSON.parse(fetchMock.mock.calls[0][1].body);
    expect(body.messages[1].content).toContain("Current chapter draft so far");
    expect(body.messages[1].content).toContain("Continue after this material");
    expect(body.messages[1].content).toContain("do not restart the chapter");
    expect(body.messages[1].content).toContain("Amaya entered NovaTech");

    vi.unstubAllGlobals();
  });

  it("includes user redraft direction in gateway section drafting", async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      new Response(
        JSON.stringify({
          choices: [{ message: { content: "## Redraft\n\nA sharper continuation." } }],
          usage: { prompt_tokens: 20, completion_tokens: 8 },
        }),
      ),
    );
    vi.stubGlobal("fetch", fetchMock);

    await draftSection(
      {
        AI_GATEWAY_BASE_URL: "https://gateway.example/compat",
        AI_GATEWAY_TOKEN: "tok",
      },
      {
        ...input,
        previousDraft: "Existing draft text.",
        redraftInstruction: "Make this tenser and keep Zeta in the scene.",
      },
    );

    const body = JSON.parse(fetchMock.mock.calls[0][1].body);
    expect(body.messages[1].content).toContain("User redraft direction");
    expect(body.messages[1].content).toContain("Make this tenser");
    expect(body.messages[1].content).toContain("Existing section draft to improve");

    vi.unstubAllGlobals();
  });

  it("returns deterministic inline edits without gateway credentials", async () => {
    // biome-ignore lint/suspicious/noExplicitAny: minimal env stub for unit test
    const result = await reviseInlineText({} as any, {
      action: "tighten",
      text: "This sentence needs to become sharper.",
      chapterTitle: "The Cost of Staying Stuck",
      chapterSummary: "Show why reactive work is expensive.",
    });

    expect(result.markdown).toContain("Tightened:");
    expect(result.llm_response.route).toBe("deterministic/local");
  });

  it("routes inline edits through dynamic/text_gen when gateway is configured", async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      new Response(
        JSON.stringify({
          choices: [{ message: { content: "Sharper replacement." } }],
          usage: { prompt_tokens: 10, completion_tokens: 4 },
        }),
      ),
    );
    vi.stubGlobal("fetch", fetchMock);

    const result = await reviseInlineText(
      {
        AI_GATEWAY_BASE_URL: "https://gateway.example/compat",
        AI_GATEWAY_TOKEN: "tok",
      },
      {
        action: "change-tone",
        tone: "punchy",
        text: "This sentence needs a clearer rhythm.",
        chapterTitle: "The Cost of Staying Stuck",
        chapterSummary: "Show why reactive work is expensive.",
      },
    );

    expect(result.markdown).toBe("Sharper replacement.");
    const body = JSON.parse(fetchMock.mock.calls[0][1].body);
    expect(body.model).toBe("dynamic/text_gen");
    expect(body.messages[1].content).toContain("change tone to punchy");

    vi.unstubAllGlobals();
  });
});
