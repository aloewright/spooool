import { useEffect, type JSX } from 'react';
import { Link, useLocation } from '@tanstack/react-router';

// ALO-408: real 404 view. Previously `<Route path="*" element={<Navigate to="/">/>`
// silently redirected unknown paths to Home, swallowing deep-link context and
// emitting no negative SEO signal. The SPA fallback still serves index.html
// with HTTP 200 — see wrangler.toml `not_found_handling = "single-page-application"`
// — so the best we can do for crawlers is inject `<meta name="robots" content="noindex">`
// from the client when this route renders.
function installNoindexMeta(): () => void {
  if (typeof document === 'undefined') return () => undefined;
  const meta = document.createElement('meta');
  meta.name = 'robots';
  meta.content = 'noindex';
  document.head.appendChild(meta);
  return () => meta.remove();
}

export function NotFound(): JSX.Element {
  const location = useLocation();

  useEffect(() => installNoindexMeta(), []);

  return (
    <main className="app-main app-main--narrow stack-lg fade-in">
      <section
        className="stack-sm"
        style={{
          alignItems: 'center',
          textAlign: 'center',
          paddingTop: 'var(--space-12)',
          paddingBottom: 'var(--space-4)',
        }}
      >
        <span className="ds-label">404</span>
        <h1 className="ds-h2">Page not found</h1>
        <p
          className="ds-lede"
          style={{ maxWidth: 480, overflowWrap: 'break-word', wordBreak: 'break-all' }}
        >
          We couldn't find <code>{location.pathname}</code>. The link may be broken or the
          page may have moved.
        </p>
        <Link to="/" className="btn">
          Go to home
        </Link>
      </section>
    </main>
  );
}
