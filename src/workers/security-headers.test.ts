import { describe, expect, it } from 'vitest';
import { Hono } from 'hono';
import { CSP_HEADER_VALUE, SECURITY_HEADERS, securityHeaders } from './security-headers';

describe('CSP_HEADER_VALUE', () => {
  it('contains the locked-down defaults', () => {
    expect(CSP_HEADER_VALUE).toContain("default-src 'self'");
    expect(CSP_HEADER_VALUE).toContain("frame-ancestors 'none'");
    expect(CSP_HEADER_VALUE).toContain("object-src 'none'");
    expect(CSP_HEADER_VALUE).toContain('upgrade-insecure-requests');
  });

  it('allows the Cloudflare Stream origins for media and connect', () => {
    expect(CSP_HEADER_VALUE).toContain('media-src');
    expect(CSP_HEADER_VALUE).toContain('https://videodelivery.net');
    expect(CSP_HEADER_VALUE).toContain('https://*.cloudflarestream.com');
  });

  it('allows the YouTube nocookie embed frame and nothing else by default', () => {
    expect(CSP_HEADER_VALUE).toContain('frame-src https://www.youtube-nocookie.com');
  });
});

describe('securityHeaders middleware', () => {
  it('attaches every static header to a normal response', async () => {
    const app = new Hono();
    app.use('*', securityHeaders());
    app.get('/', (c) => c.text('ok'));

    const response = await app.request('/');
    for (const [name, value] of Object.entries(SECURITY_HEADERS)) {
      expect(response.headers.get(name)).toBe(value);
    }
  });
});
