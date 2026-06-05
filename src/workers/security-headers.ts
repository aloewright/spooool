import type { MiddlewareHandler } from 'hono';

const CSP_DIRECTIVES: Record<string, string[]> = {
  'default-src': ["'self'"],
  'script-src': ["'self'"],
  'style-src': ["'self'", "'unsafe-inline'"],
  'img-src': ["'self'", 'data:', 'blob:', 'https:'],
  'font-src': ["'self'", 'data:'],
  'connect-src': [
    "'self'",
    'https://videodelivery.net',
    'https://*.cloudflarestream.com',
  ],
  'media-src': [
    "'self'",
    'blob:',
    'https://videodelivery.net',
    'https://*.cloudflarestream.com',
  ],
  'frame-src': ['https://www.youtube-nocookie.com'],
  'object-src': ["'none'"],
  'frame-ancestors': ["'none'"],
  'base-uri': ["'self'"],
  'form-action': ["'self'"],
  'upgrade-insecure-requests': [],
};

export const CSP_HEADER_VALUE = Object.entries(CSP_DIRECTIVES)
  .map(([directive, sources]) =>
    sources.length > 0 ? `${directive} ${sources.join(' ')}` : directive,
  )
  .join('; ');

export const SECURITY_HEADERS: Record<string, string> = {
  'Content-Security-Policy': CSP_HEADER_VALUE,
  'Strict-Transport-Security': 'max-age=63072000; includeSubDomains; preload',
  'X-Content-Type-Options': 'nosniff',
  'X-Frame-Options': 'DENY',
  'Referrer-Policy': 'strict-origin-when-cross-origin',
  'Permissions-Policy': 'camera=(), microphone=(), geolocation=(), payment=()',
  'Cross-Origin-Opener-Policy': 'same-origin',
  'Cross-Origin-Resource-Policy': 'same-origin',
  'Cross-Origin-Embedder-Policy': 'credentialless',
};

export const securityHeaders =
  (): MiddlewareHandler =>
  async (c, next) => {
    await next();
    for (const [name, value] of Object.entries(SECURITY_HEADERS)) {
      c.res.headers.set(name, value);
    }
  };
