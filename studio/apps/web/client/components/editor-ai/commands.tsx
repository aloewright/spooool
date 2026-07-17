import type { EditorAiCommand } from "@/shared/editor-ai";
import type {
  DefaultInlineContentSchema,
  DefaultStyleSchema,
  PartialInlineContentElement,
} from "@blocknote/core";
import { Sparkles } from "lucide-react";
import type { ReactElement } from "react";

export type EditorAiInstructionRequirement = "none" | "optional" | "required";

export type EditorAiMenuItem = {
  command: EditorAiCommand;
  title: string;
  subtext: string;
  aliases: readonly string[];
  icon: ReactElement;
};

const sparklesIcon = <Sparkles aria-hidden="true" size={18} />;

export const EDITOR_AI_MENU_ITEMS: readonly EditorAiMenuItem[] = [
  {
    command: "write",
    title: "Write",
    subtext: "Draft new text from the current planning context",
    aliases: ["write", "ai", "draft"],
    icon: sparklesIcon,
  },
  {
    command: "proofread",
    title: "Proofread",
    subtext: "Fix spelling and grammar, keep the voice",
    aliases: ["proofread", "ai", "grammar", "spelling"],
    icon: sparklesIcon,
  },
  {
    command: "cite",
    title: "Cite",
    subtext: "Find supporting evidence and add sources",
    aliases: ["cite", "ai", "sources", "evidence"],
    icon: sparklesIcon,
  },
  {
    command: "rewrite",
    title: "Rewrite",
    subtext: "Rewrite with instructions",
    aliases: ["rewrite", "ai", "rephrase"],
    icon: sparklesIcon,
  },
];

export function needsInstructions(command: EditorAiCommand): EditorAiInstructionRequirement {
  if (command === "write") return "optional";
  if (command === "rewrite") return "required";
  return "none";
}

type ReplacementInlineContent = PartialInlineContentElement<
  DefaultInlineContentSchema,
  DefaultStyleSchema
>;

type ReplacementBlock = {
  content?: unknown;
  children?: unknown;
};

export function flattenReplacementBlocks(
  blocks: readonly ReplacementBlock[],
): ReplacementInlineContent[] {
  const flattened: ReplacementInlineContent[] = [];

  blocks.forEach((block, index) => {
    if (
      block.children !== undefined &&
      (!Array.isArray(block.children) || block.children.length > 0)
    ) {
      throw new Error("AI returned unsupported nested block content for a text selection");
    }
    if (!Array.isArray(block.content)) {
      throw new Error("AI returned unsupported block content for a text selection");
    }

    if (index > 0) flattened.push("\n");
    flattened.push(...(block.content as ReplacementInlineContent[]));
  });

  return flattened;
}
