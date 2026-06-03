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
