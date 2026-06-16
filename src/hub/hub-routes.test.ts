import { describe, expect, it } from 'vitest';
import { hubRoutes } from './index';
import type { Env } from './env';

// Smoke test for the merged content-hub backend (sub-project #1; spec:
// docs/superpowers/specs/2026-06-15-studio-single-worker-merge-design.md).
//
// Proves the hub mounts inside the single spooool worker and that its
// /api/v1/* surface is gated by spooool's session: an unauthenticated request
// is rejected with 401 (via hubRoutes.onError mapping the thrown Unauthorized),
// NOT a 404 (which would mean the route never mounted) or a 500. With no
// session cookie, resolveSpoooolUser short-circuits before touching any
// binding, so a minimal env suffices.
describe('hubRoutes (merged content hub)', () => {
  const env = { DB: undefined, STUDIO_DB: undefined } as unknown as Env;

  it('rejects an unauthenticated GET /api/v1/projects with 401', async () => {
    const res = await hubRoutes.request('/api/v1/projects', {}, env);
    expect(res.status).toBe(401);
    expect(await res.json()).toMatchObject({ error: { code: 'Unauthorized' } });
  });

  it('mounts the route (does not 404)', async () => {
    const res = await hubRoutes.request('/api/v1/projects', {}, env);
    expect(res.status).not.toBe(404);
  });
});
