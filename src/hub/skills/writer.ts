import type { Env } from "../env";
import { gateway } from "../lib/gateway";

export type SectionDraftInput = {
  projectTitle: string;
  projectType: "nonfiction" | "fiction";
  chapterTitle: string;
  chapterSummary: string;
  kind: string;
  prompt: string;
  voiceProfile?: unknown;
  previousDraft?: string;
  currentChapterDraft?: string;
  redraftInstruction?: string;
};

export type SectionDraftResult = {
  markdown: string;
  llm_response: {
    route: "dynamic/text_gen" | "deterministic/local";
    model?: string;
    tokens_in: number;
    tokens_out: number;
  };
};

export type InlineEditAction = "rewrite" | "tighten" | "expand" | "change-tone" | "fix-grammar";
export type InlineEditTone = "formal" | "casual" | "punchy";

export type InlineEditInput = {
  action: InlineEditAction;
  tone?: InlineEditTone;
  text: string;
  chapterTitle: string;
  chapterSummary: string;
  contextMd?: string;
  voiceProfile?: unknown;
};

export type InlineEditResult = {
  markdown: string;
  llm_response: {
    route: "dynamic/text_gen" | "deterministic/local";
    tokens_in: number;
    tokens_out: number;
  };
};

export async function draftSection(
  env: Pick<Env, "AI_GATEWAY_BASE_URL" | "AI_GATEWAY_TOKEN">,
  input: SectionDraftInput,
): Promise<SectionDraftResult> {
  if (!env.AI_GATEWAY_BASE_URL || !env.AI_GATEWAY_TOKEN) {
    return deterministicDraft(input);
  }

  const result = await gateway.chatCompletion(env, {
    route: "dynamic/text_gen",
    temperature: 0.55,
    maxTokens: 1400,
    messages: [
      {
        role: "system",
        content:
          "You draft one book section at a time. Return polished markdown only. Do not include commentary, JSON, or code fences.",
      },
      {
        role: "user",
        content: [
          `Book: ${input.projectTitle} (${input.projectType})`,
          `Chapter: ${input.chapterTitle}`,
          `Chapter summary: ${input.chapterSummary || "No summary supplied."}`,
          `Section kind: ${input.kind}`,
          `Section prompt: ${input.prompt || "Draft the next coherent section."}`,
          input.voiceProfile
            ? `Voice profile JSON: ${JSON.stringify(input.voiceProfile).slice(0, 6000)}`
            : "",
          input.previousDraft ? `Existing section draft to improve:\n${input.previousDraft}` : "",
          input.redraftInstruction
            ? `User redraft direction. Follow this instruction for the generated section:\n${input.redraftInstruction}`
            : "",
          input.currentChapterDraft
            ? `Current chapter draft so far. Continue after this material; do not restart the chapter, repeat the opening, rename established companies/characters, or restate already-written beats:\n${input.currentChapterDraft.slice(0, 12000)}`
            : "",
          input.currentChapterDraft
            ? "Draft only the next additive section, 350-650 words, with strong continuity from the current ending."
            : "Draft 350-650 words with strong continuity and concrete details.",
        ]
          .filter(Boolean)
          .join("\n\n"),
      },
    ],
  });

  const markdown = normalizeDraft(result.text);
  return {
    markdown: markdown || deterministicDraft(input).markdown,
    llm_response: {
      route: "dynamic/text_gen",
      tokens_in: result.tokens_in,
      tokens_out: result.tokens_out,
    },
  };
}

export async function reviseInlineText(
  env: Pick<Env, "AI_GATEWAY_BASE_URL" | "AI_GATEWAY_TOKEN">,
  input: InlineEditInput,
): Promise<InlineEditResult> {
  if (!env.AI_GATEWAY_BASE_URL || !env.AI_GATEWAY_TOKEN) {
    return deterministicInlineEdit(input);
  }

  const result = await gateway.chatCompletion(env, {
    route: "dynamic/text_gen",
    temperature: input.action === "fix-grammar" ? 0.2 : 0.45,
    maxTokens: 900,
    messages: [
      {
        role: "system",
        content:
          "You revise selected prose inside a book editor. Return only the replacement text, preserving markdown when useful. Do not add commentary or code fences.",
      },
      {
        role: "user",
        content: [
          `Chapter: ${input.chapterTitle}`,
          `Chapter summary: ${input.chapterSummary || "No summary supplied."}`,
          `Action: ${describeInlineAction(input)}`,
          input.voiceProfile
            ? `Voice profile JSON: ${JSON.stringify(input.voiceProfile).slice(0, 6000)}`
            : "",
          input.contextMd ? `Nearby chapter context:\n${input.contextMd.slice(0, 8000)}` : "",
          `Selected text:\n${input.text}`,
        ]
          .filter(Boolean)
          .join("\n\n"),
      },
    ],
  });

  const markdown = normalizeDraft(result.text);
  return {
    markdown: markdown || deterministicInlineEdit(input).markdown,
    llm_response: {
      route: "dynamic/text_gen",
      tokens_in: result.tokens_in,
      tokens_out: result.tokens_out,
    },
  };
}

function deterministicDraft(input: SectionDraftInput): SectionDraftResult {
  const prompt = input.prompt || input.chapterSummary || "Build the next useful section.";
  const direction = input.redraftInstruction?.trim()
    ? `Apply this redraft direction: ${input.redraftInstruction.trim()}`
    : "";
  const continuation = input.currentChapterDraft?.trim()
    ? `Continue from the current chapter draft without replaying its opening or changing established names. The next section should add new material for ${titleCase(input.kind)}.`
    : `${input.chapterTitle} needs a section that turns the promise of the chapter into usable momentum.`;
  const markdown = normalizeDraft(`## ${titleCase(input.kind)}

${continuation} ${prompt} ${direction}

Start with a concrete moment that follows what is already on the page. Name the new tension plainly, then show the practical shift that resolves it.

- Add the next distinct problem, clue, scene turn, or teaching move.
- Preserve established names, setting, and continuity.
- Close by connecting the section back to the chapter promise: ${input.chapterSummary || input.chapterTitle}.`);

  return {
    markdown,
    llm_response: {
      route: "deterministic/local",
      tokens_in: countWords(prompt),
      tokens_out: countWords(markdown),
    },
  };
}

function deterministicInlineEdit(input: InlineEditInput): InlineEditResult {
  const selected = input.text.trim();
  const markdown = (() => {
    if (input.action === "tighten") return `Tightened: ${selected}`;
    if (input.action === "expand") {
      return `Expanded: ${selected} This version adds a clearer consequence, a concrete example, and a stronger connection back to ${input.chapterTitle}.`;
    }
    if (input.action === "change-tone")
      return `${titleCase(input.tone ?? "formal")} tone: ${selected}`;
    if (input.action === "fix-grammar") return `Grammar fixed: ${selected}`;
    return `Rewritten: ${selected}`;
  })();

  return {
    markdown,
    llm_response: {
      route: "deterministic/local",
      tokens_in: countWords(selected),
      tokens_out: countWords(markdown),
    },
  };
}

function describeInlineAction(input: InlineEditInput) {
  if (input.action === "change-tone") return `change tone to ${input.tone ?? "formal"}`;
  if (input.action === "fix-grammar") return "fix grammar without changing meaning";
  return input.action;
}

function normalizeDraft(text: string) {
  return text
    .replace(/^```(?:markdown|md)?\s*/i, "")
    .replace(/```$/i, "")
    .trim();
}

function titleCase(value: string) {
  return value
    .split(/[-_\s]+/)
    .filter(Boolean)
    .map((part) => `${part.charAt(0).toUpperCase()}${part.slice(1)}`)
    .join(" ");
}

function countWords(text: string) {
  return text.trim().match(/\b[\w'-]+\b/g)?.length ?? 0;
}
