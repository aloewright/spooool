import { describe, expect, it, vi, beforeEach } from 'vitest';

vi.mock('@cloudflare/tanstack-ai/adapters/workers-ai', () => ({
  createWorkersAiChat: vi.fn((model, config) => ({ kind: 'text', model, config })),
}));

import { createWorkersAiChat } from '@cloudflare/tanstack-ai/adapters/workers-ai';
import { gatewayChat, GATEWAY_ID, DEFAULT_CHAT_MODEL, resolveMode } from './ai-gateway';

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
