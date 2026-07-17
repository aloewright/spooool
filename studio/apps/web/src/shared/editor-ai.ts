import { z } from "zod";

export const EDITOR_AI_COMMANDS = ["write", "proofread", "cite", "rewrite"] as const;
export const EDITOR_AI_RESOURCE_KINDS = ["chapter", "blog-post", "script-scene"] as const;
export const EDITOR_AI_SCOPES = ["document", "selection"] as const;
export const EDITOR_AI_RESOURCE_ID_MAX_LENGTH = 200;
export const EDITOR_AI_TARGET_MARKDOWN_MAX_LENGTH = 100_000;
export const EDITOR_AI_CONTEXT_MARKDOWN_MAX_LENGTH = 200_000;
export const EDITOR_AI_INSTRUCTIONS_MAX_LENGTH = 4_000;
export const EDITOR_AI_RESOURCE_METADATA_TEXT_MAX_LENGTH = 4_000;
export const EDITOR_AI_VOICE_PROFILE_MAX_LENGTH = 6_000;

export type EditorAiCommand = (typeof EDITOR_AI_COMMANDS)[number];
export type EditorAiResourceKind = (typeof EDITOR_AI_RESOURCE_KINDS)[number];
export type EditorAiScope = (typeof EDITOR_AI_SCOPES)[number];
export type EditorAiRoute = "dynamic/text_gen" | "dynamic/research_gen";

export const editorAiRequestSchema = z
  .strictObject({
    resource_kind: z.enum(EDITOR_AI_RESOURCE_KINDS),
    resource_id: z.string().min(1).max(EDITOR_AI_RESOURCE_ID_MAX_LENGTH),
    command: z.enum(EDITOR_AI_COMMANDS),
    scope: z.enum(EDITOR_AI_SCOPES),
    target_md: z.string().max(EDITOR_AI_TARGET_MARKDOWN_MAX_LENGTH),
    context_md: z.string().max(EDITOR_AI_CONTEXT_MARKDOWN_MAX_LENGTH),
    instructions: z.string().trim().min(1).max(EDITOR_AI_INSTRUCTIONS_MAX_LENGTH).optional(),
  })
  .superRefine((value, ctx) => {
    if (value.command === "rewrite" && !value.instructions) {
      ctx.addIssue({
        code: "custom",
        path: ["instructions"],
        message: "rewrite needs instructions",
      });
    }
    if (!(value.command === "write" && value.scope === "document") && !value.target_md.trim()) {
      ctx.addIssue({ code: "custom", path: ["target_md"], message: "target is empty" });
    }
  });

export type EditorAiRequest = z.infer<typeof editorAiRequestSchema>;

export type EditorAiRevision = {
  id: string;
  before_md: string;
  after_md: string;
  llm_response: {
    route: EditorAiRoute;
    tokens_in: number;
    tokens_out: number;
  };
};
