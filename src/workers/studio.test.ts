import { describe, expect, it, vi, beforeEach } from 'vitest';
import { Hono } from 'hono';

vi.mock('@tanstack/ai', async (orig) => {
  const actual = await orig<typeof import('@tanstack/ai')>();
  return {
    ...actual,
    chat: vi.fn(() => (async function* () {
      yield { type: 'RUN_STARTED', runId: 'r1' };
      yield { type: 'TEXT_MESSAGE_CONTENT', messageId: 'm1', delta: 'hi there' };
      yield { type: 'RUN_FINISHED', runId: 'r1' };
    })()),
  };
});

import { studioRoutes } from './studio';

type U = { id: string; email: string; name: string; emailVerified: boolean } | null;
function harness(user: U, env: Record<string, unknown> = {}) {
  const app = new Hono<{ Variables: { user: U } }>();
  app.use('*', async (c, next) => { c.set('user', user); await next(); });
  app.route('/', studioRoutes);
  const base = { AI: { gateway: () => ({ run: async () => new Response('') }), run: async () => ({}) }, ...env };
  return (body: unknown) => app.request('/api/studio/chat', {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body),
  }, base);
}
const okBody = { messages: [{ role: 'user', content: 'help me name my video' }] };

describe('POST /api/studio/chat', () => {
  beforeEach(() => vi.clearAllMocks());
  it('401 when unauthenticated', async () => { expect((await harness(null)(okBody)).status).toBe(401); });
  it('403 when email not verified', async () => {
    const r = await harness({ id: 'u1', email: 'a@b.c', name: 'A', emailVerified: false })(okBody);
    expect(r.status).toBe(403);
  });
  it('streams SSE for a verified user', async () => {
    const r = await harness({ id: 'u1', email: 'a@b.c', name: 'A', emailVerified: true })(okBody);
    expect(r.status).toBe(200);
    expect(r.headers.get('content-type')).toMatch(/text\/event-stream/);
    const text = await r.text();
    expect(text).toContain('data:');
    expect(text).toContain('hi there');
  });
  it('400 on invalid body (no messages)', async () => {
    const r = await harness({ id: 'u1', email: 'a@b.c', name: 'A', emailVerified: true })({});
    expect(r.status).toBe(400);
  });
});
