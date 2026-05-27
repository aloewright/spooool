import { describe, expect, it, vi, afterEach } from 'vitest';
import { draftScript, planScenes, type AIGatewayEnv } from './create-tools';
import { heroJourney } from './create/templates/hero-journey';

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
