import { describe, expect, it } from 'vitest';
import { ComposerAgent, type ComposerAgentEnv } from './composer-agent-do';

function fakeCtx() {
  const storage = new Map<string, unknown>();
  return {
    storage: {
      get: async <T,>(key: string) => storage.get(key) as T | undefined,
      put: async (key: string, value: unknown) => { storage.set(key, value); },
      delete: async (key: string) => { storage.delete(key); },
    },
  } as unknown as DurableObjectState;
}

function envFor(extra: Partial<ComposerAgentEnv> = {}): ComposerAgentEnv {
  return {
    CF_ACCOUNT_ID: 'acc',
    CF_GATEWAY_ID: 'x',
    CF_AIG_TOKEN: 't',
    VIDEOS: {} as R2Bucket,
    DB: {} as D1Database,
    RENDER_CONTAINER: {} as DurableObjectNamespace,
    RENDER_CALLBACK_SECRET: 's',
    VIDEO_ENCODING: { send: async () => {} } as unknown as Queue<{ videoId: string; r2Key: string }>,
    ...extra,
  } as ComposerAgentEnv;
}

describe('ComposerAgent DO', () => {
  it('prime() initializes state and returns the first question', async () => {
    const agent = new ComposerAgent(fakeCtx(), envFor());
    const r = await agent.prime({ userId: 'u_1', templateId: 'hero-journey' });
    expect(r.firstQuestion.id).toBe('protagonist');
    expect(r.firstQuestion.text).toMatch(/protagonist/i);
  });

  it('answer() advances through questions and reports completion at the end', async () => {
    const agent = new ComposerAgent(fakeCtx(), envFor());
    await agent.prime({ userId: 'u_1', templateId: 'hero-journey' });
    const seen: string[] = [];
    for (let i = 0; i < 7; i++) {
      const r = await agent.answer(`a${i}`);
      if (r.type === 'question') seen.push(r.question.id);
      else { expect(r.type).toBe('questions_complete'); break; }
    }
    expect(seen).toEqual([
      'ordinary-world',
      'inciting-incident',
      'false-belief',
      'turning-point',
      'transformation',
      'closing-truth',
    ]);
  });

  it('snapshot() returns the persisted state', async () => {
    const agent = new ComposerAgent(fakeCtx(), envFor());
    await agent.prime({ userId: 'u_1', templateId: 'hero-journey' });
    await agent.answer('the hero');
    const snap = await agent.snapshot();
    expect(snap.answers.protagonist).toBe('the hero');
    expect(snap.status).toBe('questioning');
  });

  it('rejects unknown templateId', async () => {
    const agent = new ComposerAgent(fakeCtx(), envFor());
    await expect(agent.prime({ userId: 'u_1', templateId: 'nonexistent' })).rejects.toThrow(/template/);
  });
});

describe('ComposerAgent HTTP layer', () => {
  it('POST /prime calls prime() and returns the first question', async () => {
    const agent = new ComposerAgent(fakeCtx(), envFor());
    const res = await agent.fetch(new Request('https://x/prime', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ userId: 'u_1', templateId: 'hero-journey' }),
    }));
    expect(res.status).toBe(200);
    const body = await res.json() as { firstQuestion: { id: string } };
    expect(body.firstQuestion.id).toBe('protagonist');
  });

  it('GET /snapshot returns persisted state', async () => {
    const agent = new ComposerAgent(fakeCtx(), envFor());
    await agent.fetch(new Request('https://x/prime', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ userId: 'u_1', templateId: 'hero-journey' }),
    }));
    const res = await agent.fetch(new Request('https://x/snapshot', { method: 'GET' }));
    expect(res.status).toBe(200);
    const body = await res.json() as { status: string; answers: Record<string, string> };
    expect(body.status).toBe('questioning');
  });
});
