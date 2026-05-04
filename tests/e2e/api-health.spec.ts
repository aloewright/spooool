import { expect, test } from '@playwright/test';

// ALO-173: API smoke. /api/health is the single endpoint that's safe to
// hit in any environment without state setup — passes through D1, KV, R2
// pings inside the worker and reports their status.

test.describe('API health', () => {
  test('/api/health returns ok with version metadata', async ({ request }) => {
    const res = await request.get('/api/health');
    expect(res.status()).toBe(200);
    const body = (await res.json()) as { status: string; version?: { id?: string } | null };
    expect(body.status).toBe('ok');
    // version may be null in local dev where CF_VERSION_METADATA isn't bound.
    if (body.version) {
      expect(typeof body.version.id).toBe('string');
    }
  });

  test('/robots.txt is served by the worker (not falling through to assets)', async ({
    request,
  }) => {
    const res = await request.get('/robots.txt');
    expect(res.status()).toBe(200);
    const body = await res.text();
    expect(body).toContain('Sitemap:');
    expect(body).toContain('Disallow: /api/');
    expect(body).toContain('Allow: /api/oembed');
  });

  test('/sitemap.xml is XML and references the origin', async ({ request, baseURL }) => {
    const res = await request.get('/sitemap.xml');
    expect(res.status()).toBe(200);
    expect(res.headers()['content-type']).toMatch(/xml/);
    const body = await res.text();
    if (baseURL) {
      // Either a sitemapindex (for catalogs >5k videos) or a urlset must
      // reference the origin somewhere.
      expect(body).toContain(new URL(baseURL).origin);
    }
  });
});
