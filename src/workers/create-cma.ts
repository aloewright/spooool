//
// Auto-mode (one-shot) driver. Cloudflare Managed Agents is the intended
// runtime, but for v1 we run the toolchain inline within the worker —
// CMA wraps an LLM loop with tool-calling, and since our toolchain is
// fully linear (draft → plan → tts → finalize), the agent loop adds no
// value over a straight sequence. If a future template needs the LLM to
// branch / re-plan, swap this for a true CMA invocation that calls the
// same tool functions.

import { draftScript, planScenes, synthesizeTts, finalizeRender, type AIBindingEnv, type AIGatewayEnv, type R2BindingEnv } from './create-tools';
import { getTemplate } from './create/templates';
import type { RenderEnv } from './render';

export type CMAEnv = AIGatewayEnv & R2BindingEnv & AIBindingEnv & RenderEnv;

export interface CMARunDeps {
  draftScript: typeof draftScript;
  planScenes: typeof planScenes;
  synthesizeTts: typeof synthesizeTts;
  finalizeRender: typeof finalizeRender;
}

export const defaultDeps: CMARunDeps = {
  draftScript,
  planScenes,
  synthesizeTts,
  finalizeRender,
};

export async function runOneShotCMA(args: {
  userId: string;
  templateId: string;
  prompt: string;
  env: CMAEnv;
  /**
   * Pre-generated jobId. The route handler pre-inserts the render_jobs
   * row with status='queued' so it can return the jobId synchronously
   * and run this toolchain via ctx.waitUntil(). We thread the SAME id
   * through synthesizeTts AND finalizeRender so the TTS R2 key
   * (`recorder/tts/{jobId}.mp3`) matches the final job row, and so the
   * row updated when the render container completes is the same row the
   * frontend has been polling since the moment auto-mode was kicked off.
   */
  jobId: string;
  deps?: CMARunDeps;
}): Promise<{ jobId: string }> {
  const t = getTemplate(args.templateId);
  if (!t) throw new Error(`Unknown template: ${args.templateId}`);
  const d = args.deps ?? defaultDeps;

  // For one-shot we let the LLM derive answers itself by passing the raw
  // prompt as the only "answer". draft_script's system prompt fragment
  // already steers it toward the template's beat structure.
  const answers: Record<string, string> = { prompt: args.prompt };

  // Stage-by-stage timing logs so `wrangler tail` shows what the
  // background toolchain is doing for a given jobId. Each stage logs
  // start + duration_ms + a short signal (script_chars, scene_count, etc.).
  const t0 = Date.now();
  console.log('[create-cma] start', { jobId: args.jobId, templateId: args.templateId, prompt_chars: args.prompt.length });

  const tDraft = Date.now();
  const { script } = await d.draftScript({ template: t, answers, env: args.env });
  console.log('[create-cma] draft_script ok', { jobId: args.jobId, duration_ms: Date.now() - tDraft, script_chars: script.length });

  const tPlan = Date.now();
  const { scenes } = await d.planScenes({ script, template: t, env: args.env });
  console.log('[create-cma] plan_scenes ok', { jobId: args.jobId, duration_ms: Date.now() - tPlan, scene_count: scenes.length });

  // TTS failure is non-fatal — render the video silently rather than
  // strand the user with no output. Content-policy refusals from the TTS
  // provider DO bubble (they're user-facing).
  const tTts = Date.now();
  let r2Key: string | undefined;
  try {
    const result = await d.synthesizeTts({ script, voice: t.voice, jobId: args.jobId, env: args.env });
    r2Key = result.r2Key;
    console.log('[create-cma] synthesize_tts ok', { jobId: args.jobId, duration_ms: Date.now() - tTts, r2Key });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    if (/Generation failed, please try rephrasing/.test(msg)) throw err;
    console.warn('[create-cma] synthesize_tts failed — rendering silent video', { jobId: args.jobId, duration_ms: Date.now() - tTts, msg: msg.slice(0, 200) });
  }

  const tFin = Date.now();
  const { jobId } = await d.finalizeRender({
    userId: args.userId,
    scenes,
    ttsR2Key: r2Key,
    env: args.env,
    existingJobId: args.jobId,
  });
  console.log('[create-cma] finalize_render ok', { jobId: args.jobId, duration_ms: Date.now() - tFin });
  console.log('[create-cma] toolchain complete', { jobId: args.jobId, total_ms: Date.now() - t0 });
  return { jobId };
}
