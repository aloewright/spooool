import { describe, expect, it, vi } from 'vitest';
import { draftScript, planScenes, synthesizeTts, finalizeRender, type AIBindingEnv, type R2BindingEnv } from './create-tools';
import { heroJourney } from './create/templates/hero-journey';
import type { RenderEnv } from './render';

interface GatewayCall {
  slug: string;
  body: {
    provider: string;
    endpoint: string;
    query: { model: string; messages: Array<{ role: string; content: string }> };
  };
}

/**
 * Stub `env.AI.gateway(slug).run({...})`. Tests pass a `responder`
 * that returns either the raw chat completion JSON (the binding gives
 * back parsed JSON in production), a `Response`, or throws.
 */
function aiTextEnv(responder: (call: GatewayCall) => unknown | Promise<unknown>): AIBindingEnv & { _calls: GatewayCall[] } {
  const calls: GatewayCall[] = [];
  const env = {
    AI: {
      gateway(slug: string) {
        return {
          async run(body: GatewayCall['body']) {
            const call: GatewayCall = { slug, body };
            calls.push(call);
            return responder(call);
          },
        };
      },
      async run() { throw new Error('AI.run() not stubbed for this test'); },
    },
    _calls: calls,
  } as unknown as AIBindingEnv & { _calls: GatewayCall[] };
  return env;
}

function chatResponse(content: string) {
  return { choices: [{ message: { content } }] };
}

describe('draftScript', () => {
  it('calls dynamic/text_gen on gateway x and returns the script', async () => {
    const env = aiTextEnv(() => chatResponse('Once upon a time in the ordinary world…'));
    const result = await draftScript({
      template: heroJourney,
      answers: { protagonist: 'a junior dev', 'ordinary-world': 'a quiet startup' },
      env,
    });
    expect(result.script).toMatch(/Once upon a time/);
    const call = env._calls[0];
    expect(call.slug).toBe('x');
    expect(call.body.provider).toBe('compat');
    expect(call.body.endpoint).toBe('chat/completions');
    expect(call.body.query.model).toBe('dynamic/text_gen');
    // System prompt rides in messages[0] with role:'system' — OpenAI's
    // compat endpoint accepts it directly.
    expect(call.body.query.messages[0].role).toBe('system');
    expect(call.body.query.messages[0].content).toContain("hero's journey");
    expect(call.body.query.messages[1].role).toBe('user');
  });

  it('caps the returned script to 1500 chars', async () => {
    const env = aiTextEnv(() => chatResponse('x'.repeat(5000)));
    const result = await draftScript({ template: heroJourney, answers: {}, env });
    expect(result.script.length).toBe(1500);
  });

  it('retries twice on transient failure and surfaces the provider message on final failure', async () => {
    const env = aiTextEnv(() => { throw new Error('AI Gateway 503: upstream down'); });
    await expect(draftScript({ template: heroJourney, answers: {}, env })).rejects.toThrow(/Script generation failed/);
    expect(env._calls.length).toBe(3); // initial + 2 retries
  });
});

describe('planScenes', () => {
  it('returns parsed scenes array from a JSON response', async () => {
    const fakeScenes = [
      { type: 'title', durationFrames: 90, text: 'Hello world' },
      { type: 'beat', durationFrames: 120, text: 'Then everything changed' },
    ];
    const env = aiTextEnv(() => chatResponse(JSON.stringify({ scenes: fakeScenes })));
    const result = await planScenes({ script: 'Once upon a time…', template: heroJourney, env });
    expect(result.scenes).toEqual(fakeScenes);
  });

  it('re-prompts once on malformed JSON, then throws', async () => {
    const env = aiTextEnv(() => chatResponse('not json at all'));
    await expect(planScenes({ script: 'x', template: heroJourney, env })).rejects.toThrow(/Scene plan invalid/);
    expect(env._calls.length).toBe(2); // initial + 1 reprompt
  });

  it('caps scenes to 20 even when the LLM returns more', async () => {
    const many = Array.from({ length: 50 }, (_, i) => ({ type: 'beat', durationFrames: 60, text: `s${i}` }));
    const env = aiTextEnv(() => chatResponse(JSON.stringify({ scenes: many })));
    const result = await planScenes({ script: 'x', template: heroJourney, env });
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

  it('calls @cf/deepgram/aura-2-en through gateway x, writes mp3 to recorder/tts/{jobId}.mp3, returns key + durationMs', async () => {
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
    expect(seenCalls[0].opts?.gateway?.id).toBe('x');
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
