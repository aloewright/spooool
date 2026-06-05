// ALO-652: real @cloudflare/tanstack-ai TTS adapter — mock env.AI.run at the boundary only.
import { describe, expect, it } from 'vitest';
import { createWorkersAiTts } from '@cloudflare/tanstack-ai/adapters/workers-ai-tts';
import { GATEWAY_ID, DEFAULT_TTS_MODEL } from './ai-gateway';

const KNOWN_BYTES = new Uint8Array([10, 20, 30, 40, 50]);

function makeAiEnv(runResult: unknown) {
  return {
    AI: {
      gateway: (_id: string) => ({
        async run() {
          return new Response(runResult as BodyInit);
        },
      }),
      async run() {
        return runResult;
      },
    },
    AI_GATEWAY_MODE: 'gateway-binding' as const,
  };
}

describe('createWorkersAiTts real adapter (ALO-652)', () => {
  it('base64-decodes result.audio to the exact bytes returned by the gateway binding', async () => {
    const env = makeAiEnv(KNOWN_BYTES.buffer);
    const adapter = createWorkersAiTts(DEFAULT_TTS_MODEL, { binding: env.AI.gateway(GATEWAY_ID) });
    const result = await adapter.generateSpeech({ model: DEFAULT_TTS_MODEL, text: 'hello' } as never);
    const decoded = Uint8Array.from(atob(result.audio), (c) => c.charCodeAt(0));
    expect(Array.from(decoded)).toEqual(Array.from(KNOWN_BYTES));
    expect(result.format).toBe('mp3');
  });
});
