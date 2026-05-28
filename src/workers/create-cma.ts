//
// Auto-mode driver — `runOneShotCMA` exposes the four toolchain helpers
// (draft_script / plan_scenes / synthesize_tts / finalize_render) as
// LLM-callable tools via @cloudflare/ai-utils's `runWithTools` and lets
// a tool-calling model orchestrate the run.
//
// Why agent-driven instead of straight-line: the LLM gets to choose
// ordering, skip TTS when content-policy rejects it, retry plan_scenes
// after a malformed JSON, and stop early if anything looks wrong. For
// v1 the system prompt still pushes a strict order
// (draft → plan → tts → finalize) so behaviour matches what auto-mode
// did before the refactor; the runWithTools loop is the runtime shape.

import { runWithTools } from '@cloudflare/ai-utils';
import { draftScript, planScenes, synthesizeTts, finalizeRender, type AIBindingEnv, type AIGatewayEnv, type R2BindingEnv, type SceneSpec } from './create-tools';
import { getTemplate } from './create/templates';
import type { RenderEnv } from './render';

export type CMAEnv = AIGatewayEnv & R2BindingEnv & AIBindingEnv & RenderEnv;

// Tool-calling model. Per @cloudflare/ai-utils docs this is the
// confirmed-working Workers AI function-calling model. Routing the
// run through gateway 'x' so the agent loop's chat calls show up in
// the AI Gateway dashboard alongside the tool-driven sub-calls.
const AGENT_MODEL = '@hf/nousresearch/hermes-2-pro-mistral-7b';
const AGENT_GATEWAY = 'x';

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
   * Pre-generated jobId. The route handler pre-inserts the
   * render_jobs row with status='queued' so it can return the jobId
   * synchronously and run this toolchain via ctx.waitUntil(). We
   * thread the SAME id through synthesize_tts AND finalize_render so
   * the TTS R2 key (`recorder/tts/{jobId}.mp3`) matches the final
   * job row.
   */
  jobId: string;
  deps?: CMARunDeps;
}): Promise<{ jobId: string }> {
  const t = getTemplate(args.templateId);
  if (!t) throw new Error(`Unknown template: ${args.templateId}`);
  const d = args.deps ?? defaultDeps;

  // Intermediate state shared across tool invocations. The LLM
  // doesn't pass data between tools — it just calls them in order
  // and they read/write this closure-scoped state.
  const state: {
    script?: string;
    scenes?: SceneSpec[];
    ttsR2Key?: string;
    finalJobId?: string;
  } = {};
  const t0 = Date.now();
  console.log('[create-cma] start', { jobId: args.jobId, templateId: args.templateId, prompt_chars: args.prompt.length });

  await runWithTools(
    args.env.AI as unknown as Parameters<typeof runWithTools>[0],
    AGENT_MODEL,
    {
      messages: [
        {
          role: 'system',
          content: `You are an automated video-production agent. Use the provided tools in this order to produce a video for the user:
1. Call draft_script first.
2. Call plan_scenes next.
3. Call synthesize_tts (optional — if it fails, that's fine, continue without audio).
4. Call finalize_render last.

Do not skip steps 1, 2, or 4. After finalize_render returns, reply with a single short sentence confirming the render has been dispatched. Do not call any tool more than once unless one returned an error.`,
        },
        { role: 'user', content: args.prompt },
      ],
      tools: [
        {
          name: 'draft_script',
          description: "Drafts the narration script from the user's prompt + the active template. Must be called first.",
          parameters: { type: 'object', properties: {}, required: [] },
          function: async () => {
            const tStage = Date.now();
            const { script } = await d.draftScript({ template: t, answers: { prompt: args.prompt }, env: args.env });
            state.script = script;
            console.log('[create-cma] draft_script ok', { jobId: args.jobId, duration_ms: Date.now() - tStage, script_chars: script.length });
            return JSON.stringify({ ok: true, script_chars: script.length });
          },
        },
        {
          name: 'plan_scenes',
          description: 'Breaks the drafted script into title/beat/outro scenes with frame durations. Must be called after draft_script and before finalize_render.',
          parameters: { type: 'object', properties: {}, required: [] },
          function: async () => {
            if (!state.script) throw new Error('plan_scenes called before draft_script');
            const tStage = Date.now();
            const { scenes } = await d.planScenes({ script: state.script, template: t, env: args.env });
            state.scenes = scenes;
            console.log('[create-cma] plan_scenes ok', { jobId: args.jobId, duration_ms: Date.now() - tStage, scene_count: scenes.length });
            return JSON.stringify({ ok: true, scene_count: scenes.length });
          },
        },
        {
          name: 'synthesize_tts',
          description: 'Generates a voiceover MP3 from the script and uploads it to R2. Optional — if it fails, the render still proceeds silently. Call after plan_scenes if you want audio, otherwise skip straight to finalize_render.',
          parameters: { type: 'object', properties: {}, required: [] },
          function: async () => {
            if (!state.script) throw new Error('synthesize_tts called before draft_script');
            const tStage = Date.now();
            try {
              const { r2Key } = await d.synthesizeTts({ script: state.script, voice: t.voice, jobId: args.jobId, env: args.env });
              state.ttsR2Key = r2Key;
              console.log('[create-cma] synthesize_tts ok', { jobId: args.jobId, duration_ms: Date.now() - tStage, r2Key });
              return JSON.stringify({ ok: true, r2_key: r2Key });
            } catch (err) {
              const msg = err instanceof Error ? err.message : String(err);
              // Content-policy refusals are user-facing and must abort
              // the whole run; surface to the agent (which will stop).
              if (/Generation failed, please try rephrasing/.test(msg)) throw err;
              console.warn('[create-cma] synthesize_tts failed — proceeding silent', { jobId: args.jobId, duration_ms: Date.now() - tStage, msg: msg.slice(0, 200) });
              return JSON.stringify({ ok: false, error: msg.slice(0, 200), note: 'render will proceed without audio' });
            }
          },
        },
        {
          name: 'finalize_render',
          description: 'Dispatches the render container with the planned scenes (and optional TTS audio). Must be called last. Returns the render job id.',
          parameters: { type: 'object', properties: {}, required: [] },
          function: async () => {
            if (!state.scenes) throw new Error('finalize_render called before plan_scenes');
            const tStage = Date.now();
            const { jobId } = await d.finalizeRender({
              userId: args.userId,
              scenes: state.scenes,
              ttsR2Key: state.ttsR2Key,
              env: args.env,
              existingJobId: args.jobId,
            });
            state.finalJobId = jobId;
            console.log('[create-cma] finalize_render ok', { jobId: args.jobId, duration_ms: Date.now() - tStage });
            return JSON.stringify({ ok: true, job_id: jobId });
          },
        },
      ],
    },
  );

  if (!state.finalJobId) {
    // The LLM ran the tool loop but never called finalize_render —
    // possibly because draft/plan/tts all failed or because the model
    // gave up mid-loop. Either way the job didn't get dispatched.
    throw new Error('Agent loop completed without calling finalize_render');
  }

  console.log('[create-cma] toolchain complete', { jobId: args.jobId, total_ms: Date.now() - t0, agent: AGENT_MODEL });
  return { jobId: state.finalJobId };
}
