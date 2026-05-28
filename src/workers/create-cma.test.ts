import { describe, expect, it, vi } from 'vitest';

// Mock runWithTools so tests don't need a live LLM. The mock simulates a
// "good" agent that calls the tools in the documented order
// (draft_script → plan_scenes → synthesize_tts → finalize_render).
// Individual tests can override the mock via mockImplementationOnce to
// simulate different agent behaviours (skipping tts, finalize never
// invoked, etc.).
type ToolFn = (args: unknown) => Promise<string> | undefined;
type RunWithToolsOpts = { tools: Array<{ name: string; function?: ToolFn }> };

vi.mock('@cloudflare/ai-utils', () => ({
  runWithTools: vi.fn(async (_ai: unknown, _model: unknown, opts: RunWithToolsOpts) => {
    const byName = new Map(opts.tools.map((t) => [t.name, t.function]));
    for (const name of ['draft_script', 'plan_scenes', 'synthesize_tts', 'finalize_render']) {
      const fn = byName.get(name);
      if (fn) await fn({});
    }
    return { response: 'done' };
  }),
}));

import { runOneShotCMA, type CMARunDeps } from './create-cma';
import { runWithTools } from '@cloudflare/ai-utils';

const mockedRunWithTools = vi.mocked(runWithTools);

describe('runOneShotCMA', () => {
  it('threads through draft → plan → tts → finalize and returns the jobId', async () => {
    const calls: string[] = [];
    const deps: CMARunDeps = {
      draftScript: vi.fn(async () => { calls.push('draft'); return { script: 'a script' }; }),
      planScenes: vi.fn(async () => { calls.push('plan'); return { scenes: [{ type: 'title' as const, durationFrames: 60, text: 'hi' }] }; }),
      synthesizeTts: vi.fn(async () => { calls.push('tts'); return { r2Key: 'recorder/tts/j_cma.mp3', durationMs: 5000 }; }),
      finalizeRender: vi.fn(async () => { calls.push('finalize'); return { jobId: 'j_cma' }; }),
    };
    const result = await runOneShotCMA({
      userId: 'u_1',
      templateId: 'hero-journey',
      prompt: 'A junior dev learns Cloudflare Workers',
      env: { AI: {}, CF_ACCOUNT_ID: 'a', CF_GATEWAY_ID: 'x', CF_AIG_TOKEN: 't' } as never,
      jobId: 'j_cma',
      deps,
    });
    expect(result.jobId).toBe('j_cma');
    expect(calls).toEqual(['draft', 'plan', 'tts', 'finalize']);
  });

  it('passes the caller-supplied jobId to synthesizeTts AND finalizeRender (so the TTS R2 key matches the render row)', async () => {
    const ttsSpy = vi.fn(async (args: { jobId: string }) => ({ r2Key: `recorder/tts/${args.jobId}.mp3`, durationMs: 1000 }));
    const finalizeSpy = vi.fn(async (args: { existingJobId?: string }) => ({ jobId: args.existingJobId ?? 'unexpected' }));
    const deps: CMARunDeps = {
      draftScript: vi.fn(async () => ({ script: 's' })),
      planScenes: vi.fn(async () => ({ scenes: [{ type: 'title' as const, durationFrames: 60, text: 'hi' }] })),
      synthesizeTts: ttsSpy as unknown as CMARunDeps['synthesizeTts'],
      finalizeRender: finalizeSpy as unknown as CMARunDeps['finalizeRender'],
    };
    const result = await runOneShotCMA({
      userId: 'u_1',
      templateId: 'hero-journey',
      prompt: 'x',
      env: { AI: {}, CF_ACCOUNT_ID: 'a', CF_GATEWAY_ID: 'x', CF_AIG_TOKEN: 't' } as never,
      jobId: 'j_unified',
      deps,
    });
    expect(result.jobId).toBe('j_unified');
    expect(ttsSpy.mock.calls[0][0].jobId).toBe('j_unified');
    expect(finalizeSpy.mock.calls[0][0].existingJobId).toBe('j_unified');
    expect(finalizeSpy.mock.calls[0][0]).toMatchObject({ ttsR2Key: 'recorder/tts/j_unified.mp3' });
  });

  it('rejects unknown templateId', async () => {
    await expect(
      runOneShotCMA({
        userId: 'u_1',
        templateId: 'made-up',
        prompt: 'x',
        env: {} as never,
        jobId: 'j_x',
        deps: {} as never,
      }),
    ).rejects.toThrow(/template/i);
  });

  it('continues when synthesize_tts fails (silent video render)', async () => {
    const calls: string[] = [];
    const deps: CMARunDeps = {
      draftScript: vi.fn(async () => { calls.push('draft'); return { script: 's' }; }),
      planScenes: vi.fn(async () => { calls.push('plan'); return { scenes: [{ type: 'title' as const, durationFrames: 60, text: 'hi' }] }; }),
      synthesizeTts: vi.fn(async () => { calls.push('tts'); throw new Error('Workers AI 500 - busy'); }),
      finalizeRender: vi.fn(async (args: { ttsR2Key?: string }) => { calls.push('finalize'); return { jobId: 'j_silent', ttsKey: args.ttsR2Key }; }) as unknown as CMARunDeps['finalizeRender'],
    };
    const result = await runOneShotCMA({
      userId: 'u_1',
      templateId: 'hero-journey',
      prompt: 'x',
      env: { AI: {}, CF_ACCOUNT_ID: 'a', CF_GATEWAY_ID: 'x', CF_AIG_TOKEN: 't' } as never,
      jobId: 'j_silent',
      deps,
    });
    expect(result.jobId).toBe('j_silent');
    expect(calls).toEqual(['draft', 'plan', 'tts', 'finalize']);
    expect((deps.finalizeRender as ReturnType<typeof vi.fn>).mock.calls[0][0].ttsR2Key).toBeUndefined();
  });

  it('throws when the agent loop completes without calling finalize_render', async () => {
    // Override the mock for this test: simulate an agent that calls
    // draft and plan but bails before finalize (e.g. LLM stops generating
    // tool calls early).
    mockedRunWithTools.mockImplementationOnce(async (_ai: unknown, _model: unknown, opts: RunWithToolsOpts) => {
      const byName = new Map(opts.tools.map((t) => [t.name, t.function]));
      await byName.get('draft_script')!({});
      await byName.get('plan_scenes')!({});
      return { response: 'gave up' };
    });
    const deps: CMARunDeps = {
      draftScript: vi.fn(async () => ({ script: 's' })),
      planScenes: vi.fn(async () => ({ scenes: [{ type: 'title' as const, durationFrames: 60, text: 'hi' }] })),
      synthesizeTts: vi.fn(async () => ({ r2Key: '', durationMs: 0 })),
      finalizeRender: vi.fn(async () => ({ jobId: 'unused' })),
    };
    await expect(
      runOneShotCMA({
        userId: 'u_1',
        templateId: 'hero-journey',
        prompt: 'x',
        env: { AI: {}, CF_ACCOUNT_ID: 'a', CF_GATEWAY_ID: 'x', CF_AIG_TOKEN: 't' } as never,
        jobId: 'j_no_finalize',
        deps,
      }),
    ).rejects.toThrow(/without calling finalize_render/);
    expect((deps.finalizeRender as ReturnType<typeof vi.fn>)).not.toHaveBeenCalled();
  });
});
