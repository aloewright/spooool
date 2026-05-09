// ALO-127: launch / about page. Doubles as the press post and the onramp
// to the dedicated /waitlist page. Anchor #waitlist still works so existing
// inbound links from /pricing don't 404.

import { Link } from 'react-router-dom';

export function About(): JSX.Element {
  return (
    <main className="app-main app-main--narrow stack-lg fade-in">
      <section className="stack-sm" style={{ textAlign: 'center', paddingTop: 'var(--space-6)' }}>
        <h1 className="ds-h1" style={{ margin: 0 }}>A video host that respects your time.</h1>
        <p className="ds-lede" style={{ maxWidth: 560, margin: '0 auto' }}>
          spooool is open to the public today. No ads. No autoplay traps. No infinite-scroll
          rabbit holes. Just upload, watch, share.
        </p>
        <div style={{ display: 'flex', gap: 'var(--space-2)', justifyContent: 'center', flexWrap: 'wrap' }}>
          <Link to="/signup" className="btn btn--secondary">Create an account</Link>
          <Link to="/pricing" className="btn btn--ghost">See pricing</Link>
        </div>
      </section>

      <section className="stack-sm">
        <h2 className="ds-h3" style={{ margin: 0 }}>What we ship today</h2>
        <ul className="ds-meta">
          <li>HLS adaptive streaming with hls.js + native fallback</li>
          <li>Channel pages, comments, likes, watch history, search, tags</li>
          <li>Better-auth email/password with verification</li>
          <li>DMCA takedown + counter-notice flow</li>
          <li>PostHog analytics, Sentry error tracking, OpenTelemetry traces</li>
          <li>Cloudflare-native: Workers, D1, R2, Stream, KV</li>
        </ul>
      </section>

      <section className="stack-sm" id="waitlist">
        <h2 className="ds-h3" style={{ margin: 0 }}>Member tier waitlist</h2>
        <p className="ds-meta">
          The paid Member tier ships shortly after launch. Drop your email on the{' '}
          <Link to="/waitlist">waitlist</Link> and we&apos;ll let you know when checkout
          opens — first 100 get a founding-member discount.
        </p>
      </section>

      <section className="stack-sm">
        <h2 className="ds-h3" style={{ margin: 0 }}>Press</h2>
        <p className="ds-meta">
          Media inquiries: <a href="mailto:press@spooool.com">press@spooool.com</a>. Brand
          assets and a one-pager are available on request.
        </p>
      </section>
    </main>
  );
}
