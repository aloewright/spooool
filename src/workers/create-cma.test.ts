import { describe, expect, it, vi } from 'vitest';
import { runOneShotCMA, type CMARunDeps } from './create-cma';

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
      env: { CF_ACCOUNT_ID: 'a', CF_GATEWAY_ID: 'x', CF_AIG_TOKEN: 't' } as never,
      deps,
    });
    expect(result.jobId).toBe('j_cma');
    expect(calls).toEqual(['draft', 'plan', 'tts', 'finalize']);
  });

  it('rejects unknown templateId', async () => {
    await expect(
      runOneShotCMA({
        userId: 'u_1',
        templateId: 'made-up',
        prompt: 'x',
        env: {} as never,
        deps: {} as never,
      }),
    ).rejects.toThrow(/template/i);
  });
});
