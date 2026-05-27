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
    route: 'dynamic/text_gen',
    resolvedModel: 'Claude-class LLM (gateway-routed)',
    costUsd: 0.008,
    description: 'Drafts narration from your prompt + template system prompt.',
  },
  {
    stage: 'plan_scenes',
    route: 'dynamic/text_gen',
    resolvedModel: 'Claude-class LLM (gateway-routed)',
    costUsd: 0.011,
    description: 'Breaks the script into title/beat/outro scenes with frame durations.',
  },
  {
    stage: 'synthesize_tts',
    route: 'dynamic/audio_gen',
    resolvedModel: 'OpenAI TTS / ElevenLabs (gateway-routed)',
    costUsd: 0.018,
    description: 'Generates a narrated mp3 from the script and writes it to R2.',
  },
  {
    stage: 'render',
    route: 'CF Container (Remotion + Chromium + ffmpeg)',
    resolvedModel: 'spooool-render:1.0.4 / standard-3',
    costUsd: 0.013,
    description: 'Renders the explainer composition into an MP4. ~2 minutes wall clock.',
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
