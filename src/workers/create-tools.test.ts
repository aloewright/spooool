import { describe, expect, it, vi } from 'vitest';
import { draftScript, planScenes, synthesizeTts, finalizeRender, type AIBindingEnv, type R2BindingEnv } from './create-tools';
import { heroJourney } from './create/templates/hero-journey';
import type { RenderEnv } from './render';

interface RunCall {
  model: string;
  input: Record<string, unknown>;
  opts?: { gateway?: { id: string } };
}

/**
 * Stub `env.AI.run(model, input, opts)`. Tests pass a `responder` that
 * returns the model output (Workers AI returns `{ response: string }`
 * for chat-completions on @cf/google/gemma-* models), a `Response`,
 * or throws.
 */
function aiTextEnv(responder: (call: RunCall) => unknown | Promise<unknown>): AIBindingEnv & { _calls: RunCall[] } {
  const calls: RunCall[] = [];
  const env = {
    // AI_GATEWAY_MODE:'run-gateway' routes chatComplete through runGatewayChat,
    // which calls env.AI.run (the only Worker-side path confirmed working per CLAUDE.md).
    AI_GATEWAY_MODE: 'run-gateway' as const,
    AI: {
      async run(model: string, input: Record<string, unknown>, opts?: { gateway?: { id: string } }) {
        const call: RunCall = { model, input, opts };
        calls.push(call);
        return responder(call);
      },
      gateway() { throw new Error('text gen should not invoke env.AI.gateway()'); },
    },
    _calls: calls,
  } as unknown as AIBindingEnv & { _calls: RunCall[] };
  return env;
}

function chatResponse(content: string) {
  return { response: content };
}

describe('draftScript', () => {
  it('calls @cf/google/gemma-4-26b-a4b-it via env.AI.run with gateway x and returns the script', async () => {
    const env = aiTextEnv(() => chatResponse('Once upon a time in the ordinary world…'));
    const result = await draftScript({
      template: heroJourney,
      answers: { protagonist: 'a junior dev', 'ordinary-world': 'a quiet startup' },
      env,
    });
    expect(result.script).toMatch(/Once upon a time/);
    const call = env._calls[0];
    expect(call.model).toBe('@cf/google/gemma-4-26b-a4b-it');
    expect(call.opts?.gateway?.id).toBe('x');
    const messages = call.input.messages as Array<{ role: string; content: string }>;
    expect(messages[0].role).toBe('system');
    expect(messages[0].content).toContain("hero's journey");
    expect(messages[1].role).toBe('user');
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

  it('[gateway-binding mode] returns a script via gateway binding (success-path coverage for production transport)', async () => {
    // Build an env WITHOUT AI_GATEWAY_MODE so chatComplete defaults to
    // gateway-binding mode and routes through createWorkersAiChat({ binding: env.AI.gateway('x') }).
    // The gateway binding's run() returns a minimal OpenAI-compat JSON response
    // (non-streaming shape). The @cloudflare/tanstack-ai adapter calls
    // binding.run(request, { signal }), uses the response as if returned by
    // the OpenAI SDK fetch, and emits TEXT_MESSAGE_CONTENT chunks which
    // chatComplete accumulates into the final string.
    // env.AI.run is stubbed to throw — it must NOT be called in this mode,
    // verifying that the gateway-binding path is the only one exercised.
    //
    // Why success-path rather than error-path: when gateway.run() throws, the
    // @cloudflare/tanstack-ai adapter catches the error, falls back to a second
    // non-streaming call, which also throws. The OpenAI SDK's internal retry
    // logic then waits before giving up, causing the test to exceed vitest's
    // 5 s default timeout. The success-path is equally valid coverage of the
    // production transport — it confirms gateway-binding mode is wired end-to-end.
    const gatewayRunCalls: unknown[] = [];
    // The @cloudflare/tanstack-ai workers-ai adapter always requests stream:true
    // first. Return a proper OpenAI-compat SSE stream so the streaming path
    // succeeds and emits TEXT_MESSAGE_CONTENT chunks (the non-streaming fallback
    // only fires on a fetch error, which we can't trigger without a timeout).
    const content = 'A hero rises from the ordinary world.';
    const model = '@cf/google/gemma-4-26b-a4b-it';
    const streamId = 'workers-ai-test';
    const created = Math.floor(Date.now() / 1000);
    function makeOpenAiSseResponse(text: string): Response {
      // Emit: one delta chunk with the content, then a finish chunk, then [DONE].
      const deltaChunk = JSON.stringify({
        id: streamId, object: 'chat.completion.chunk', created, model,
        choices: [{ index: 0, delta: { role: 'assistant', content: text }, finish_reason: null }],
      });
      const doneChunk = JSON.stringify({
        id: streamId, object: 'chat.completion.chunk', created, model,
        choices: [{ index: 0, delta: {}, finish_reason: 'stop' }],
      });
      const sse = `data: ${deltaChunk}\n\ndata: ${doneChunk}\n\ndata: [DONE]\n\n`;
      return new Response(sse, {
        headers: { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache' },
      });
    }
    const env = {
      // Explicit gateway-binding mode (run-gateway is the default now) so this
      // test exercises createWorkersAiChat({ binding: env.AI.gateway('x') }).
      AI_GATEWAY_MODE: 'gateway-binding' as const,
      AI: {
        gateway(_slug: string) {
          return {
            async run(req: unknown): Promise<Response> {
              gatewayRunCalls.push(req);
              return makeOpenAiSseResponse(content);
            },
          };
        },
        run(_model: string, _input: Record<string, unknown>, _opts?: unknown): never {
          throw new Error('env.AI.run must not be called in gateway-binding mode');
        },
      },
    } as unknown as AIBindingEnv;

    const result = await draftScript({ template: heroJourney, answers: {}, env });
    expect(result.script).toMatch(/hero rises/i);
    // At least one gateway.run call was made (streaming attempt or non-streaming
    // fallback) — confirms the gateway-binding transport was exercised.
    expect(gatewayRunCalls.length).toBeGreaterThanOrEqual(1);
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

  it('throws Scene plan invalid on malformed JSON (no internal retry)', async () => {
    // The old hand-rolled double-attempt is replaced by chat({ outputSchema }),
    // which validates internally and throws on malformed / invalid output.
    // We assert the error message shape only; call count is not asserted because
    // outputSchema validation is an internal detail of the @tanstack/ai layer.
    const env = aiTextEnv(() => chatResponse('not json at all'));
    await expect(planScenes({ script: 'x', template: heroJourney, env })).rejects.toThrow(/Scene plan invalid/);
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
      put: async (key: string, body: ArrayBuffer | Uint8Array | ReadableStream, opts?: { httpMetadata?: { contentType?: string } }) => {
        // After the generateSpeech() refactor, synthesizeTts passes a Uint8Array
        // (decoded from base64). Support both ArrayBuffer and Uint8Array.
        const bytes = body instanceof Uint8Array ? body.byteLength : body instanceof ArrayBuffer ? body.byteLength : -1;
        puts.push({ key, bytes, contentType: opts?.httpMetadata?.contentType });
      },
    } as unknown as R2Bucket;
    return { VIDEOS, _puts: puts };
  }

  /**
   * Fake AI binding for TTS tests — run-gateway mode so generateSpeech()
   * routes through runGatewayTts → env.AI.run (the only Worker-side path
   * confirmed working per CLAUDE.md). AI_GATEWAY_MODE must be set so
   * gatewayTts() selects runGatewayTts instead of the gateway-binding adapter.
   *
   * `run` takes a model id + input + opts; in run-gateway mode runGatewayTts
   * calls env.AI.run('@cf/deepgram/aura-2-en', { text, speaker, encoding: 'mp3' },
   * { gateway: { id: 'x' } }) and base64-encodes the result into TTSResult.audio.
   * synthesizeTts then decodes it with atob() before writing to R2.
   *
   * gateway() is stubbed to throw — in run-gateway mode the gateway binding is
   * never used for TTS.
   */
  function aiEnv(run: (model: string, input: Record<string, unknown>, opts?: { gateway?: { id: string } }) => Promise<ArrayBuffer | Uint8Array | Response>): AIBindingEnv {
    return {
      AI_GATEWAY_MODE: 'run-gateway' as const,
      AI: {
        run,
        gateway() { throw new Error('synthesizeTts should not invoke env.AI.gateway() in run-gateway mode'); },
      } as unknown as AIBindingEnv['AI'],
    } as unknown as AIBindingEnv;
  }

  it('calls @cf/deepgram/aura-2-en through gateway x, writes mp3 to recorder/tts/{jobId}.mp3, returns key + durationMs', async () => {
    const seenCalls: Array<{ model: string; input: Record<string, unknown>; opts?: { gateway?: { id: string } } }> = [];
    // 4 raw audio bytes; runGatewayTts base64-encodes them into TTSResult.audio;
    // synthesizeTts atob()-decodes back to the original bytes before R2.put.
    const rawAudio = new Uint8Array([0xff, 0xfb, 0x90, 0x00]);
    const r2 = r2Env();
    const env: TtsEnv = {
      ...r2,
      ...aiEnv(async (model, input, opts) => {
        seenCalls.push({ model, input, opts });
        return rawAudio;
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
    // runGatewayTts calls env.AI.run exactly once with the correct model + input.
    expect(seenCalls).toHaveLength(1);
    expect(seenCalls[0].model).toBe('@cf/deepgram/aura-2-en');
    expect(seenCalls[0].input).toMatchObject({ text: 'Hello world.', speaker: 'asteria-en', encoding: 'mp3' });
    expect(seenCalls[0].opts?.gateway?.id).toBe('x');
    expect(r2._puts[0]).toMatchObject({ key: 'recorder/tts/j_abc.mp3', contentType: 'audio/mpeg' });
    // Base64 round-trip: atob(btoa(rawAudio)) must recover the original 4 bytes.
    expect(r2._puts[0].bytes).toBe(4);
  });

  it('rejects scripts longer than 2000 chars before calling Workers AI', async () => {
    const env: TtsEnv = { ...r2Env(), ...aiEnv(async () => { throw new Error('should not be called'); }) };
    await expect(
      synthesizeTts({ script: 'x'.repeat(2001), voice: { profile: 'warm', pacingWpm: 150 }, jobId: 'j_x', env }),
    ).rejects.toThrow(/script too long/i);
  });

  it('masks content-policy refusals with a generic message', async () => {
    // runGatewayTts propagates env.AI.run rejections to generateSpeech(), which
    // synthesizeTts catches and masks when isContentPolicyMsg returns true.
    const env: TtsEnv = {
      ...r2Env(),
      ...aiEnv(async () => { throw new Error('Inference failed: content_policy_violation — forbidden'); }),
    };
    await expect(
      synthesizeTts({ script: 'hi', voice: { profile: 'warm', pacingWpm: 150 }, jobId: 'j_y', env }),
    ).rejects.toThrow(/Generation failed, please try rephrasing/);
  });

  it('surfaces upstream errors as TTS synthesis failed', async () => {
    // runGatewayTts propagates env.AI.run rejections to generateSpeech(), which
    // synthesizeTts catches and re-wraps with the 'TTS synthesis failed:' prefix.
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
