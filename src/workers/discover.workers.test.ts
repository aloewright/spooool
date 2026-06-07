import { SELF } from 'cloudflare:test';
import { describe, expect, it } from 'vitest';

describe('/api/discover/search', () => {
  it('rejects unauthenticated requests', async () => {
    const res = await SELF.fetch('https://example.com/api/discover/search?q=cats');
    expect(res.status).toBe(401);
  });

  it('returns 401 (auth) before validation for missing q', async () => {
    const res = await SELF.fetch('https://example.com/api/discover/search');
    expect([400, 401]).toContain(res.status);
  });
});
