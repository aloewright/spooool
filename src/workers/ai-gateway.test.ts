import { describe, expect, it, vi, beforeEach } from 'vitest';

vi.mock('@cloudflare/tanstack-ai/adapters/workers-ai', () => ({
  createWorkersAiChat: vi.fn((model, config) => ({ kind: 'text', model, config })),
}));

vi.mock('@cloudflare/tanstack-ai/adapters/workers-ai-image', () => ({
  createWorkersAiImage: vi.fn((model, config) => ({ kind: 'image', model, config })),
}));

vi.mock('@cloudflare/tanstack-ai/adapters/workers-ai-tts', () => ({
  createWorkersAiTts: vi.fn((model, config) => ({ kind: 'tts', model, config })),
}));

vi.mock('@cloudflare/tanstack-ai/adapters/workers-ai-transcription', () => ({
  createWorkersAiTranscription: vi.fn((model, config) => ({ kind: 'transcription', model, config })),
}));

vi.mock('@cloudflare/tanstack-ai/adapters/workers-ai-summarize', () => ({
  createWorkersAiSummarize: vi.fn((model, config) => ({ kind: 'summarize', model, config })),
}));

import { createWorkersAiChat } from '@cloudflare/tanstack-ai/adapters/workers-ai';
import { createWorkersAiImage } from '@cloudflare/tanstack-ai/adapters/workers-ai-image';
import { createWorkersAiTts } from '@cloudflare/tanstack-ai/adapters/workers-ai-tts';
import { createWorkersAiTranscription } from '@cloudflare/tanstack-ai/adapters/workers-ai-transcription';
import { createWorkersAiSummarize } from '@cloudflare/tanstack-ai/adapters/workers-ai-summarize';
import {
  gatewayChat,
  gatewayImage,
  gatewayTts,
  gatewayTranscription,
  gatewaySummarize,
  GATEWAY_ID,
  DEFAULT_CHAT_MODEL,
  DEFAULT_IMAGE_MODEL,
  DEFAULT_TTS_MODEL,
  DEFAULT_STT_MODEL,
  DEFAULT_SUMMARIZE_MODEL,
  resolveMode,
} from './ai-gateway';

function makeEnv(overrides = {}) {
  const gatewaySentinel = { __gateway: true };
  return { AI: { gateway: vi.fn(() => gatewaySentinel), run: vi.fn() }, ...overrides } as any;
}

describe('ai-gateway gateway-binding mode', () => {
  beforeEach(() => vi.clearAllMocks());

  it('defaults to gateway-binding mode', () => {
    expect(resolveMode(makeEnv())).toBe('gateway-binding');
  });

  it('gatewayChat builds the adapter against env.AI.gateway(GATEWAY_ID), not plain env.AI', () => {
    const env = makeEnv();
    gatewayChat(env);
    expect(env.AI.gateway).toHaveBeenCalledWith(GATEWAY_ID);
    expect(createWorkersAiChat).toHaveBeenCalledWith(DEFAULT_CHAT_MODEL, { binding: env.AI.gateway(GATEWAY_ID) });
    const [, config] = (createWorkersAiChat as any).mock.calls[0];
    expect(config.binding).not.toBe(env.AI); // observability guard: never plain env.AI
  });
});

describe('ai-gateway run-gateway mode', () => {
  beforeEach(() => vi.clearAllMocks());

  it('resolveMode returns run-gateway when AI_GATEWAY_MODE is set', () => {
    expect(resolveMode(makeEnv({ AI_GATEWAY_MODE: 'run-gateway' }))).toBe('run-gateway');
  });

  it('gatewayTts calls env.AI.run with @cf model + gateway opts, never env.AI.gateway, and base64-round-trips bytes', async () => {
    const env = makeEnv({ AI_GATEWAY_MODE: 'run-gateway' });
    env.AI.run.mockResolvedValue(new Uint8Array([1, 2, 3, 4]));

    const adapter = gatewayTts(env);
    expect(adapter.kind).toBe('tts');

    const result = await adapter.generateSpeech({ model: DEFAULT_TTS_MODEL, text: 'hello', voice: 'aura-asteria-en' } as any);

    // exact byte-for-byte parity with create-tools.ts: (model, { text, speaker, encoding }, { gateway: { id } })
    expect(env.AI.run).toHaveBeenCalledWith(
      DEFAULT_TTS_MODEL,
      { text: 'hello', speaker: 'aura-asteria-en', encoding: 'mp3' },
      { gateway: { id: GATEWAY_ID } },
    );
    // never the gateway *binding* — that is the thing we are de-risking around.
    expect(env.AI.gateway).not.toHaveBeenCalled();

    expect(result.format).toBe('mp3');
    // base64 must DECODE back to exactly [1,2,3,4] (catches a double-encode bug).
    const decoded = Uint8Array.from(atob(result.audio), (c) => c.charCodeAt(0));
    expect(Array.from(decoded)).toEqual([1, 2, 3, 4]);
  });

  it('gatewayTts handles a Response result by awaiting arrayBuffer()', async () => {
    const env = makeEnv({ AI_GATEWAY_MODE: 'run-gateway' });
    env.AI.run.mockResolvedValue(new Response(new Uint8Array([9, 8, 7]).buffer));

    const result = await gatewayTts(env).generateSpeech({ model: DEFAULT_TTS_MODEL, text: 'hi' } as any);
    const decoded = Uint8Array.from(atob(result.audio), (c) => c.charCodeAt(0));
    expect(Array.from(decoded)).toEqual([9, 8, 7]);
  });

  it('gatewayChat returns a text adapter that drives env.AI.run (not env.AI.gateway) and yields the model text', async () => {
    const env = makeEnv({ AI_GATEWAY_MODE: 'run-gateway' });
    env.AI.run.mockResolvedValue({ response: 'hello world' });

    const adapter = gatewayChat(env);
    expect(adapter.kind).toBe('text');

    const messages = [{ role: 'user', content: 'hi' }];
    const chunks: any[] = [];
    for await (const chunk of adapter.chatStream({ model: DEFAULT_CHAT_MODEL, messages } as any)) {
      chunks.push(chunk);
    }

    // byte-for-byte parity with create-tools.ts chat call
    expect(env.AI.run).toHaveBeenCalledWith(
      DEFAULT_CHAT_MODEL,
      { messages, max_tokens: 800 },
      { gateway: { id: GATEWAY_ID } },
    );
    expect(env.AI.gateway).not.toHaveBeenCalled();

    // correct AG-UI lifecycle: RUN_STARTED → TEXT_MESSAGE_START → CONTENT(delta) → END → RUN_FINISHED
    expect(chunks.map((c) => c.type)).toEqual([
      'RUN_STARTED',
      'TEXT_MESSAGE_START',
      'TEXT_MESSAGE_CONTENT',
      'TEXT_MESSAGE_END',
      'RUN_FINISHED',
    ]);
    const content = chunks.find((c) => c.type === 'TEXT_MESSAGE_CONTENT');
    expect(content.delta).toBe('hello world');
    // start/content/end share one messageId
    const ids = new Set(chunks.filter((c) => 'messageId' in c).map((c) => c.messageId));
    expect(ids.size).toBe(1);
  });

  it('gatewayChat narrows the OpenAI-compat choices[].message.content shape too', async () => {
    const env = makeEnv({ AI_GATEWAY_MODE: 'run-gateway' });
    env.AI.run.mockResolvedValue({ choices: [{ message: { content: 'compat text' } }] });

    const chunks: any[] = [];
    for await (const chunk of gatewayChat(env).chatStream({ model: DEFAULT_CHAT_MODEL, messages: [] } as any)) {
      chunks.push(chunk);
    }
    expect(chunks.find((c) => c.type === 'TEXT_MESSAGE_CONTENT')?.delta).toBe('compat text');
  });

  it('gatewayChat.structuredOutput parses JSON from the model text into { data, rawText }', async () => {
    const env = makeEnv({ AI_GATEWAY_MODE: 'run-gateway' });
    env.AI.run.mockResolvedValue({ response: '{"ok":true,"n":42}' });

    const out = await gatewayChat(env).structuredOutput({
      chatOptions: { model: DEFAULT_CHAT_MODEL, messages: [] },
      outputSchema: {},
    } as any);

    expect(env.AI.run).toHaveBeenCalledWith(
      DEFAULT_CHAT_MODEL,
      { messages: [], max_tokens: 800 },
      { gateway: { id: GATEWAY_ID } },
    );
    expect(env.AI.gateway).not.toHaveBeenCalled();
    expect(out.rawText).toBe('{"ok":true,"n":42}');
    expect(out.data).toEqual({ ok: true, n: 42 });
  });

  it('run-gateway never builds adapters against the plain env.AI binding (createWorkersAi* untouched)', () => {
    const env = makeEnv({ AI_GATEWAY_MODE: 'run-gateway' });
    gatewayChat(env);
    gatewayTts(env);
    expect(createWorkersAiChat).not.toHaveBeenCalled();
    expect(createWorkersAiTts).not.toHaveBeenCalled();
  });
});

describe('ai-gateway: every activity is gateway-routed', () => {
  beforeEach(() => vi.clearAllMocks());

  it.each([
    ['image', () => gatewayImage(makeEnv()), createWorkersAiImage, DEFAULT_IMAGE_MODEL],
    ['tts', () => gatewayTts(makeEnv()), createWorkersAiTts, DEFAULT_TTS_MODEL],
    ['transcription', () => gatewayTranscription(makeEnv()), createWorkersAiTranscription, DEFAULT_STT_MODEL],
    ['summarize', () => gatewaySummarize(makeEnv()), createWorkersAiSummarize, DEFAULT_SUMMARIZE_MODEL],
  ] as const)(
    'gateway%s routes through env.AI.gateway(GATEWAY_ID), not plain env.AI',
    (_label, call, factory, model) => {
      const adapter = call();
      const lastCall = (factory as any).mock.calls.at(-1);
      expect(lastCall[0]).toBe(model);
      expect(lastCall[1].binding).toEqual({ __gateway: true });
      expect(lastCall[1].binding).not.toBe((adapter as any).envAI); // never plain binding
    },
  );
});
