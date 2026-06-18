// Formats a project's compose-wizard answers into a system-prompt block for
// the Editorial Assistant, so the agent knows the concept without the author
// re-typing it. Shared so the formatting is unit-testable without DO plumbing.

export type ProjectBriefInput = {
  title: string;
  type: string;
  genre?: string | null;
  logline?: string;
  audience_json?: unknown;
  voice_styles_json?: unknown;
};

function asStringArray(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value.filter((v): v is string => typeof v === "string" && v.length > 0);
}

export function buildProjectBriefPrompt(p: ProjectBriefInput): string {
  const audience = asStringArray(p.audience_json);
  const voiceStyles = asStringArray(p.voice_styles_json);
  const lines = [
    `Title: ${p.title}`,
    `Type: ${p.type}`,
    ...(p.genre?.trim() ? [`Genre: ${p.genre.trim()}`] : []),
    ...(p.logline?.trim() ? [`Logline: ${p.logline.trim()}`] : []),
    ...(audience.length > 0 ? [`Audience: ${audience.join(", ")}`] : []),
    ...(voiceStyles.length > 0 ? [`Voice & tone: ${voiceStyles.join(", ")}`] : []),
  ];
  return `The author's book, from their setup answers (treat as ground truth, though the author may revise any of it in conversation):\n${lines.map((line) => `- ${line}`).join("\n")}`;
}
