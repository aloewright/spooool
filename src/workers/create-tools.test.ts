import { describe, expect, it, vi, beforeEach } from 'vitest';
import { draftScript, planScenes, synthesizeTts, finalizeRender, type AIBindingEnv, type AIGatewayEnv, type R2BindingEnv } from './create-tools';
import { heroJourney } from './create/templates/hero-journey';
import type { RenderEnv } from './render';

interface GenerateTextCall {
  model: unknown;
  system?: string;
  messages?: Array<{ role: string; content: string }>;
}

// Mock the Vercel AI SDK + ai-gateway-provider so we never make a real
// network call. `chatComplete` calls `generateText({ model, messages })`,
// so we intercept that and let each test inject the response.
const generateTextSpy = vi.fn<(args: GenerateTextCall) => Promise<{ text: string }>>();
vi.mock('ai', () => ({
  generateText: (args: GenerateTextCall) => generateTextSpy(args),
}));

// The provider factories return opaque tokens that get passed through
// to generateText; their identity doesn't matter for tests because the
// spy never inspects them.
vi.mock('ai-gateway-provider', () => ({
  createAiGateway: () => (model: unknown) => model,
}));
vi.mock('ai-gateway-provider/providers/unified', () => ({
  createUnified: () => (route: string) => ({ __unified: route }),
}));

beforeEach(() => { generateTextSpy.mockReset(); });

function envFor(): AIGatewayEnv {
  return {
    CF_ACCOUNT_ID: 'acc_test',
    CF_GATEWAY_ID: 'spooool',
    CF_AIG_TOKEN: 'tok_test',
  };
}

describe('draftScript', () => {
  it('calls generateText with the dynamic/text_gen route and the template system prompt', async () => {
    generateTextSpy.mockResolvedValueOnce({ text: 'Once upon a time in the ordinary world…' });
    const result = await draftScript({
      template: heroJourney,
      answers: { protagonist: 'a junior dev', 'ordinary-world': 'a quiet startup' },
      env: envFor(),
    });
    expect(result.script).toMatch(/Once upon a time/);
    expect(generateTextSpy).toHaveBeenCalledTimes(1);
    const call = generateTextSpy.mock.calls[0][0];
    // The provider wrapped `dynamic/text_gen` and passed it through as `model`.
    expect((call.model as { __unified: string }).__unified).toBe('dynamic/text_gen');
    expect(call.system).toContain("hero's journey");
    expect(call.messages?.[0].role).toBe('user');
  });

  it('caps the returned script to 1500 chars', async () => {
    generateTextSpy.mockResolvedValueOnce({ text: 'x'.repeat(5000) });
    const result = await draftScript({ template: heroJourney, answers: {}, env: envFor() });
    expect(result.script.length).toBe(1500);
  });

  it('retries twice on transient failure and surfaces the provider message on final failure', async () => {
    generateTextSpy.mockRejectedValue(new Error('AI Gateway 503: upstream down'));
    await expect(draftScript({ template: heroJourney, answers: {}, env: envFor() })).rejects.toThrow(/Script generation failed/);
    expect(generateTextSpy).toHaveBeenCalledTimes(3); // initial + 2 retries
  });
});

describe('planScenes', () => {
  it('returns parsed scenes array from a JSON response', async () => {
    const fakeScenes = [
      { type: 'title', durationFrames: 90, text: 'Hello world' },
      { type: 'beat', durationFrames: 120, text: 'Then everything changed' },
    ];
    generateTextSpy.mockResolvedValueOnce({ text: JSON.stringify({ scenes: fakeScenes }) });
    const result = await planScenes({ script: 'Once upon a time…', template: heroJourney, env: envFor() });
    expect(result.scenes).toEqual(fakeScenes);
  });

  it('re-prompts once on malformed JSON, then throws', async () => {
    generateTextSpy.mockResolvedValue({ text: 'not json at all' });
    await expect(planScenes({ script: 'x', template: heroJourney, env: envFor() })).rejects.toThrow(/Scene plan invalid/);
    expect(generateTextSpy).toHaveBeenCalledTimes(2); // initial + 1 reprompt
  });

  it('caps scenes to 20 even when the LLM returns more', async () => {
    const many = Array.from({ length: 50 }, (_, i) => ({ type: 'beat', durationFrames: 60, text: `s${i}` }));
    generateTextSpy.mockResolvedValueOnce({ text: JSON.stringify({ scenes: many }) });
    const result = await planScenes({ script: 'x', template: heroJourney, env: envFor() });
    expect(result.scenes).toHaveLength(20);
  });
});

describe('synthesizeTts', () => {
  type TtsEnv = R2BindingEnv & AIBindingEnv;
  function r2Env(): { VIDEOS: R2Bucket; _puts: Array<{ key: string; bytes: number; contentType?: string }> } {
    const puts: Array<{ key: string; bytes: number; contentType?: string }> = [];
    const VIDEOS = {
      put: async (key: string, body: ArrayBuffer | ReadableStream, opts?: { httpMetadata?: { contentType?: string } }) => {
        const bytes = body instanceof ArrayBuffer ? body.byteLength : -1;
        puts.push({ key, bytes, contentType: opts?.httpMetadata?.contentType });
      },
    } as unknown as R2Bucket;
    return { VIDEOS, _puts: puts };
  }

  /**
   * Fake AI binding. `run` takes a model id + input + opts; in production it
   * resolves with audio bytes from Workers AI Deepgram. `gateway()` is
   * stubbed to throw — TTS uses `env.AI.run` directly, not the dynamic-
   * route gateway proxy (Vertex Gemini + Workers AI Deepgram each want
   * different request shapes; see notes in create-tools.ts).
   */
  function aiEnv(run: (model: string, input: Record<string, unknown>, opts?: { gateway?: { id: string } }) => Promise<ArrayBuffer | Uint8Array | Response>): AIBindingEnv {
    return {
      AI: {
        run,
        gateway() { throw new Error('synthesizeTts should not invoke env.AI.gateway()'); },
      } as unknown as AIBindingEnv['AI'],
    };
  }

  it('calls @cf/deepgram/aura-2-en through the spooool gateway, writes mp3 to recorder/tts/{jobId}.mp3, returns key + durationMs', async () => {
    const seenCalls: Array<{ model: string; input: Record<string, unknown>; opts?: { gateway?: { id: string } } }> = [];
    const audioBytes = new Uint8Array([0xff, 0xfb, 0x90, 0x00]);
    const r2 = r2Env();
    const env: TtsEnv = {
      ...r2,
      ...aiEnv(async (model, input, opts) => {
        seenCalls.push({ model, input, opts });
        return audioBytes;
      }),
    };
    const result = await synthesizeTts({
      script: 'Hello world.',
      voice: { profile: 'warm', pacingWpm: 150 },
      jobId: 'j_abc',
      env,
    });
    expect(result.r2Key).toBe('recorder/tts/j_abc.mp3');
    expect(result.durationMs).toBeGreaterThan(0);
    expect(seenCalls).toHaveLength(1);
    expect(seenCalls[0].model).toBe('@cf/deepgram/aura-2-en');
    expect(seenCalls[0].input).toMatchObject({ text: 'Hello world.', speaker: 'asteria-en', encoding: 'mp3' });
    expect(seenCalls[0].opts?.gateway?.id).toBe('spooool');
    expect(r2._puts[0]).toMatchObject({ key: 'recorder/tts/j_abc.mp3', contentType: 'audio/mpeg' });
  });

  it('rejects scripts longer than 2000 chars before calling Workers AI', async () => {
    const env: TtsEnv = { ...r2Env(), ...aiEnv(async () => { throw new Error('should not be called'); }) };
    await expect(
      synthesizeTts({ script: 'x'.repeat(2001), voice: { profile: 'warm', pacingWpm: 150 }, jobId: 'j_x', env }),
    ).rejects.toThrow(/script too long/i);
  });

  it('masks content-policy refusals with a generic message', async () => {
    const env: TtsEnv = {
      ...r2Env(),
      ...aiEnv(async () => { throw new Error('Inference failed: content_policy_violation — forbidden'); }),
    };
    await expect(
      synthesizeTts({ script: 'hi', voice: { profile: 'warm', pacingWpm: 150 }, jobId: 'j_y', env }),
    ).rejects.toThrow(/Generation failed, please try rephrasing/);
  });

  it('surfaces upstream errors as TTS synthesis failed', async () => {
    const env: TtsEnv = {
      ...r2Env(),
      ...aiEnv(async () => { throw new Error('Workers AI 500 - model busy'); }),
    };
    await expect(
      synthesizeTts({ script: 'hi', voice: { profile: 'warm', pacingWpm: 150 }, jobId: 'j_z', env }),
    ).rejects.toThrow(/TTS synthesis failed: .*model busy/);
  });
});

describe('finalizeRender', () => {
  it('calls submitRenderJob with compositionId=spooool-explainer and the scenes + audio key', async () => {
    const seen: Array<{ userId: string; takeKeys: string[]; compositionProps: Record<string, unknown> }> = [];
    const renderEnv = {
      DB: {
        prepare: () => ({ bind: () => ({ run: async () => ({ success: true }) }) }),
      } as unknown as D1Database,
      RENDER_CONTAINER: {
        idFromName: (name: string) => ({ name } as unknown as DurableObjectId),
        get: () => ({ fetch: async () => new Response('{}', { status: 200 }) }),
      } as unknown as DurableObjectNamespace,
      RENDER_CALLBACK_SECRET: 's',
      VIDEO_ENCODING: { send: async () => {} } as unknown as Queue<{ videoId: string; r2Key: string }>,
    } as RenderEnv;

    // Spy by wrapping submitRenderJob via env-injected helper.
    const submitSpy = vi.fn(async (input: { userId: string; takeKeys: string[]; compositionProps: Record<string, unknown> }) => {
      seen.push(input);
      return { jobId: 'j_finalize' };
    });

    const result = await finalizeRender({
      userId: 'u_1',
      scenes: [{ type: 'title', durationFrames: 60, text: 'hi' }],
      ttsR2Key: 'recorder/tts/j_test.mp3',
      env: renderEnv,
      submitRenderJob: submitSpy,
    });

    expect(result.jobId).toBe('j_finalize');
    expect(submitSpy).toHaveBeenCalledTimes(1);
    expect(seen[0].userId).toBe('u_1');
    expect(seen[0].takeKeys).toEqual([]);
    expect(seen[0].compositionProps).toMatchObject({
      compositionId: 'spooool-explainer',
      scenes: [{ type: 'title', durationFrames: 60, text: 'hi' }],
      audio: { r2Key: 'recorder/tts/j_test.mp3' },
    });
  });
});
