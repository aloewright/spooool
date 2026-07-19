import type { MiddlewareHandler } from 'hono';

const CSP_DIRECTIVES: Record<string, string[]> = {
  'default-src': ["'self'"],
  // challenges.cloudflare.com: Turnstile CAPTCHA script loader.
  'script-src': [
    "'self'",
    'https://challenges.cloudflare.com',
    'https://*.posthog.com',
  ],
  'style-src': ["'self'", "'unsafe-inline'"],
  'img-src': ["'self'", 'data:', 'blob:', 'https:'],
  'font-src': ["'self'", 'data:'],
  'connect-src': [
    "'self'",
    'https://videodelivery.net',
    'https://*.cloudflarestream.com',
    // Turnstile token validation.
    'https://challenges.cloudflare.com',
    // PostHog analytics and lazy session replay assets.
    'https://*.posthog.com',
    // Sentry browser error reporting.
    'https://*.ingest.sentry.io',
  ],
  'media-src': [
    "'self'",
    'blob:',
    'https://videodelivery.net',
    'https://*.cloudflarestream.com',
  ],
  'worker-src': ["'self'", 'blob:', 'data:'],
  // challenges.cloudflare.com: Turnstile renders inside a sandboxed iframe.
  'frame-src': ['https://www.youtube-nocookie.com', 'https://challenges.cloudflare.com'],
  'object-src': ["'none'"],
  'frame-ancestors': ["'none'"],
  'base-uri': ["'self'"],
  'form-action': ["'self'"],
  'upgrade-insecure-requests': [],
};

// Embed pages (/embed/:id) must be frameable from any origin.
// Only frame-ancestors and Cross-Origin-Resource-Policy differ from the
// default; everything else (script-src, object-src, etc.) is unchanged.
const EMBED_CSP_DIRECTIVES: Record<string, string[]> = {
  ...CSP_DIRECTIVES,
  'frame-ancestors': ['*'],
};

export const CSP_HEADER_VALUE = Object.entries(CSP_DIRECTIVES)
  .map(([directive, sources]) =>
    sources.length > 0 ? `${directive} ${sources.join(' ')}` : directive,
  )
  .join('; ');

const EMBED_CSP_HEADER_VALUE = Object.entries(EMBED_CSP_DIRECTIVES)
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

// Applied to /embed/:id responses. No X-Frame-Options and relaxed
// frame-ancestors so the player can be embedded in third-party pages.
export const EMBED_SECURITY_HEADERS: Record<string, string> = {
  'Content-Security-Policy': EMBED_CSP_HEADER_VALUE,
  'Strict-Transport-Security': 'max-age=63072000; includeSubDomains; preload',
  'X-Content-Type-Options': 'nosniff',
  'Referrer-Policy': 'strict-origin-when-cross-origin',
  'Permissions-Policy': 'camera=(), microphone=(), geolocation=(), payment=()',
  'Cross-Origin-Opener-Policy': 'same-origin',
  'Cross-Origin-Resource-Policy': 'cross-origin',
  'Cross-Origin-Embedder-Policy': 'credentialless',
};

export const securityHeaders =
  (): MiddlewareHandler =>
  async (c, next) => {
    await next();
    const isEmbed = c.req.path.startsWith('/embed/');
    const headers = isEmbed ? EMBED_SECURITY_HEADERS : SECURITY_HEADERS;
    for (const [name, value] of Object.entries(headers)) {
      c.res.headers.set(name, value);
    }
  };
