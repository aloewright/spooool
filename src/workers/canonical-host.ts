// Canonical-host redirect (ALO-OAUTH / state_mismatch fix).
//
// The worker is served from several hosts — the canonical browsing origin
// (spooool.com), a dedicated auth custom domain (auth.pdx.software) that
// BETTER_AUTH_URL has historically pointed at, the apex's own subdomains
// (www.*), and the *.workers.dev URL. better-auth's OAuth flow stores a
// HOST-SCOPED state cookie (`__Secure-better-auth.state`) when the sign-in
// POST is made. If the provider then redirects the callback to a *different*
// host than the one that set the cookie, the cookie is not presented, the
// state check fails, and the user lands on `?error=state_mismatch` (the
// verification row in D1 is left unconsumed).
//
// This was happening in production: users sign in on spooool.com (cookie set
// there) but BETTER_AUTH_URL resolves the Google redirect_uri to
// auth.pdx.software, so the callback lands on auth.pdx.software with no state
// cookie. 301-ing alias hosts to the canonical origin — preserving path +
// query — makes that callback self-heal: the browser re-requests
// /api/auth/callback/google?code=…&state=… on spooool.com, where the state
// cookie lives, and better-auth completes the flow.
//
// The proper upstream fix is to set BETTER_AUTH_URL to https://spooool.com and
// register https://spooool.com/api/auth/callback/{google,github} in the OAuth
// consoles; this redirect is defense-in-depth that also keeps the canonical
// origin authoritative for cookies regardless of which alias a user lands on.

export const CANONICAL_HOST = 'spooool.com';

// Extra non-subdomain hosts that route to this same worker but must never be
// the origin a browser session is pinned to. Kept explicit (not a wildcard)
// so preview *.workers.dev deployments used for manual QA are left alone.
const EXTRA_ALIAS_HOSTS = new Set(['auth.pdx.software']);

export function isAliasHost(hostname: string): boolean {
  const host = hostname.toLowerCase();
  if (host === CANONICAL_HOST) return false;
  // Any subdomain of the canonical apex (www.spooool.com, app.spooool.com, …).
  if (host.endsWith(`.${CANONICAL_HOST}`)) return true;
  return EXTRA_ALIAS_HOSTS.has(host);
}

// Returns a 301 redirect to the canonical origin when `req` targets an alias
// host, otherwise null. Only GET/HEAD navigations are redirected — a 301 on a
// POST would drop the body, and webhooks (Stream, Polar, encoder callbacks)
// are configured against specific hosts and must reach the worker unmolested.
export function canonicalHostRedirect(req: Request): Response | null {
  const method = req.method.toUpperCase();
  if (method !== 'GET' && method !== 'HEAD') return null;

  let url: URL;
  try {
    url = new URL(req.url);
  } catch {
    return null;
  }
  if (!isAliasHost(url.hostname)) return null;

  url.hostname = CANONICAL_HOST;
  url.protocol = 'https:';
  url.port = '';
  return Response.redirect(url.toString(), 301);
}
