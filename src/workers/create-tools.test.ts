import { describe, expect, it, vi, afterEach } from 'vitest';
import { draftScript, planScenes, synthesizeTts, finalizeRender, type AIGatewayEnv, type R2BindingEnv } from './create-tools';
import { heroJourney } from './create/templates/hero-journey';
import type { RenderEnv } from './render';

const originalFetch = globalThis.fetch;
afterEach(() => { globalThis.fetch = originalFetch; });

function mockGateway(impl: (path: string, init: RequestInit) => Promise<Response>) {
  globalThis.fetch = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof input === 'string' ? input : input.toString();
    return impl(url, init ?? {});
  }) as unknown as typeof fetch;
}

function envFor(): AIGatewayEnv {
  return {
    CF_ACCOUNT_ID: 'acc_test',
    CF_GATEWAY_ID: 'x',
    CF_AIG_TOKEN: 'tok_test',
  };
}

describe('draftScript', () => {
  it('calls dynamic/text_gen with the template system prompt and returns the script', async () => {
    let seenBody: { model: string; messages: Array<{ role: string; content: string }> } | null = null;
    mockGateway(async (url, init) => {
      seenBody = JSON.parse(init.body as string);
      return new Response(JSON.stringify({ choices: [{ message: { content: 'Once upon a time in the ordinary world…' } }] }), { status: 200 });
    });
    const result = await draftScript({
      template: heroJourney,
      answers: { protagonist: 'a junior dev', 'ordinary-world': 'a quiet startup' },
      env: envFor(),
    });
    expect(result.script).toMatch(/Once upon a time/);
    expect(seenBody!.model).toBe('dynamic/text_gen');
    expect(seenBody!.messages[0].content).toContain("hero's journey");
  });

  it('caps the returned script to 1500 chars', async () => {
    mockGateway(async () => new Response(JSON.stringify({ choices: [{ message: { content: 'x'.repeat(5000) } }] }), { status: 200 }));
    const result = await draftScript({ template: heroJourney, answers: {}, env: envFor() });
    expect(result.script.length).toBe(1500);
  });

  it('retries twice on 5xx and surfaces the provider message on final failure', async () => {
    let calls = 0;
    mockGateway(async () => { calls++; return new Response('upstream down', { status: 503 }); });
    await expect(draftScript({ template: heroJourney, answers: {}, env: envFor() })).rejects.toThrow(/Script generation failed/);
    expect(calls).toBe(3); // initial + 2 retries
  });
});

describe('planScenes', () => {
  it('returns parsed scenes array from a JSON response', async () => {
    const fakeScenes = [
      { type: 'title', durationFrames: 90, text: 'Hello world' },
      { type: 'beat', durationFrames: 120, text: 'Then everything changed' },
    ];
    mockGateway(async () => new Response(JSON.stringify({ choices: [{ message: { content: JSON.stringify({ scenes: fakeScenes }) } }] }), { status: 200 }));
    const result = await planScenes({ script: 'Once upon a time…', template: heroJourney, env: envFor() });
    expect(result.scenes).toEqual(fakeScenes);
  });

  it('re-prompts once on malformed JSON, then throws', async () => {
    let calls = 0;
    mockGateway(async () => {
      calls++;
      return new Response(JSON.stringify({ choices: [{ message: { content: 'not json at all' } }] }), { status: 200 });
    });
    await expect(planScenes({ script: 'x', template: heroJourney, env: envFor() })).rejects.toThrow(/Scene plan invalid/);
    expect(calls).toBe(2); // initial + 1 reprompt
  });

  it('caps scenes to 20 even when the LLM returns more', async () => {
    const many = Array.from({ length: 50 }, (_, i) => ({ type: 'beat', durationFrames: 60, text: `s${i}` }));
    mockGateway(async () => new Response(JSON.stringify({ choices: [{ message: { content: JSON.stringify({ scenes: many }) } }] }), { status: 200 }));
    const result = await planScenes({ script: 'x', template: heroJourney, env: envFor() });
    expect(result.scenes).toHaveLength(20);
  });
});

describe('synthesizeTts', () => {
  function r2Env(): R2BindingEnv {
    const puts: Array<{ key: string; bytes: number; contentType?: string }> = [];
    const VIDEOS = {
      put: async (key: string, body: ArrayBuffer | ReadableStream, opts?: { httpMetadata?: { contentType?: string } }) => {
        const bytes = body instanceof ArrayBuffer ? body.byteLength : -1;
        puts.push({ key, bytes, contentType: opts?.httpMetadata?.contentType });
      },
    } as unknown as R2Bucket;
    (VIDEOS as unknown as { _puts: typeof puts })._puts = puts;
    return { VIDEOS };
  }

  it('calls dynamic/audio_gen, writes mp3 to recorder/tts/{jobId}.mp3, returns key + durationMs', async () => {
    const audioBytes = new Uint8Array([0xff, 0xfb, 0x90, 0x00]); // tiny fake mp3 header bytes
    mockGateway(async (url) => {
      expect(url).toContain('/audio/speech');
      return new Response(audioBytes, { status: 200, headers: { 'content-type': 'audio/mpeg' } });
    });
    const env = { ...envFor(), ...r2Env() };
    const result = await synthesizeTts({
      script: 'Hello world.',
      voice: { profile: 'warm', pacingWpm: 150 },
      jobId: 'j_abc',
      env,
    });
    expect(result.r2Key).toBe('recorder/tts/j_abc.mp3');
    expect(result.durationMs).toBeGreaterThan(0);
    const puts = (env.VIDEOS as unknown as { _puts: Array<{ key: string; contentType?: string }> })._puts;
    expect(puts[0]).toMatchObject({ key: 'recorder/tts/j_abc.mp3', contentType: 'audio/mpeg' });
  });

  it('rejects scripts longer than 2000 chars before calling the gateway', async () => {
    const env = { ...envFor(), ...r2Env() };
    mockGateway(async () => new Response('should not be called', { status: 200 }));
    await expect(
      synthesizeTts({ script: 'x'.repeat(2001), voice: { profile: 'warm', pacingWpm: 150 }, jobId: 'j_x', env }),
    ).rejects.toThrow(/script too long/i);
  });

  it('masks content-policy refusals with a generic message', async () => {
    mockGateway(async () => new Response(JSON.stringify({ error: { code: 'content_policy_violation', message: 'forbidden' } }), { status: 400 }));
    const env = { ...envFor(), ...r2Env() };
    await expect(
      synthesizeTts({ script: 'hi', voice: { profile: 'warm', pacingWpm: 150 }, jobId: 'j_y', env }),
    ).rejects.toThrow(/Generation failed, please try rephrasing/);
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
