// Static cost estimates per stage of the prompt-to-video toolchain.
//
// These are intentionally hardcoded snapshots, not live AI Gateway pulls —
// good enough for the user to see "what this will roughly cost" before they
// hit Generate. Update when the AI Gateway route configs change.
//
// Modeled on the OpenMontage pricing pattern (docs/PROVIDERS.md) — publish
// the published per-model rates upfront so the user can reason about cost
// per generation.

export interface StageCost {
  /** Tool / stage name as it appears in the toolchain. */
  stage: string;
  /** AI Gateway dynamic route the tool calls. */
  route: string;
  /** Plain-language description of the resolved model. */
  resolvedModel: string;
  /** Cost in USD per typical invocation for a 60-90s explainer. */
  costUsd: number;
  /** Short description of what this stage does. */
  description: string;
}

export const STAGE_COSTS: StageCost[] = [
  {
    stage: 'draft_script',
    route: 'dynamic/text (spooool)',
    resolvedModel: '@cf/zai-org/glm-4.7-flash → fallback @cf/meta/llama-3.3-70b-instruct-fp8-fast',
    costUsd: 0.004,
    description: 'Drafts narration from your prompt + template system prompt.',
  },
  {
    stage: 'plan_scenes',
    route: 'dynamic/text (spooool)',
    resolvedModel: '@cf/zai-org/glm-4.7-flash → fallback @cf/meta/llama-3.3-70b-instruct-fp8-fast',
    costUsd: 0.005,
    description: 'Breaks the script into title/beat/outro scenes with frame durations.',
  },
  {
    stage: 'synthesize_tts',
    route: 'env.AI.run via spooool gateway',
    resolvedModel: '@cf/deepgram/aura-2-en (Workers AI binding)',
    costUsd: 0.012,
    description: 'Generates a narrated mp3 from the script and writes it to R2. Failure is non-fatal — render proceeds silently.',
  },
  {
    stage: 'render',
    route: 'CF Container (Remotion + Chromium + ffmpeg)',
    resolvedModel: 'spooool-render:1.0.4 / standard-3',
    costUsd: 0.013,
    description: 'Renders the explainer composition into an MP4. ~1–2 minutes wall clock.',
  },
];

export function totalEstimateUsd(): number {
  return STAGE_COSTS.reduce((sum, s) => sum + s.costUsd, 0);
}

export function formatUsd(n: number): string {
  if (n < 0.01) return `$${n.toFixed(4)}`;
  if (n < 1) return `$${n.toFixed(3)}`;
  return `$${n.toFixed(2)}`;
}
