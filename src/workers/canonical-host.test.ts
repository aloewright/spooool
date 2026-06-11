import { Hono } from 'hono';
import { describe, expect, it } from 'vitest';
import { CANONICAL_HOST, canonicalHostRedirect, isAliasHost } from './canonical-host';

describe('isAliasHost', () => {
  it('treats the canonical host as non-alias', () => {
    expect(isAliasHost(CANONICAL_HOST)).toBe(false);
  });

  it('treats subdomains of the canonical apex as aliases', () => {
    expect(isAliasHost('www.spooool.com')).toBe(true);
    expect(isAliasHost('app.spooool.com')).toBe(true);
  });

  it('treats the dedicated auth custom domain as an alias', () => {
    expect(isAliasHost('auth.pdx.software')).toBe(true);
  });

  it('is case-insensitive', () => {
    expect(isAliasHost('WWW.Spooool.com')).toBe(true);
  });

  it('leaves localhost and unrelated hosts alone', () => {
    expect(isAliasHost('localhost')).toBe(false);
    expect(isAliasHost('spooool.com.evil.example')).toBe(false);
  });
});

describe('canonicalHostRedirect', () => {
  it('301s an OAuth callback from the auth alias to the canonical host, preserving path + query', () => {
    const res = canonicalHostRedirect(
      new Request(
        'https://auth.pdx.software/api/auth/callback/google?code=abc&state=xyz',
      ),
    );
    expect(res?.status).toBe(301);
    expect(res?.headers.get('location')).toBe(
      'https://spooool.com/api/auth/callback/google?code=abc&state=xyz',
    );
  });

  it('301s www to the apex', () => {
    const res = canonicalHostRedirect(new Request('https://www.spooool.com/watch/123'));
    expect(res?.headers.get('location')).toBe('https://spooool.com/watch/123');
  });

  it('does not redirect the canonical host', () => {
    expect(canonicalHostRedirect(new Request('https://spooool.com/'))).toBeNull();
  });

  it('does not redirect localhost (dev)', () => {
    expect(canonicalHostRedirect(new Request('http://localhost:5173/'))).toBeNull();
  });

  it('does not redirect non-GET/HEAD requests (webhooks keep their body)', () => {
    expect(
      canonicalHostRedirect(
        new Request('https://auth.pdx.software/api/webhooks/polar', { method: 'POST' }),
      ),
    ).toBeNull();
  });

  it('redirects HEAD as well as GET', () => {
    const res = canonicalHostRedirect(
      new Request('https://auth.pdx.software/', { method: 'HEAD' }),
    );
    expect(res?.status).toBe(301);
    expect(res?.headers.get('location')).toBe('https://spooool.com/');
  });

  it('runs as the first middleware, short-circuiting alias traffic', async () => {
    const app = new Hono();
    app.use('*', async (c, next) => {
      const redirect = canonicalHostRedirect(c.req.raw);
      if (redirect) return redirect;
      return next();
    });
    app.get('/api/health', (c) => c.json({ ok: true }));

    const aliased = await app.request('https://auth.pdx.software/api/health');
    expect(aliased.status).toBe(301);

    const canonical = await app.request('https://spooool.com/api/health');
    expect(canonical.status).toBe(200);
  });
});
