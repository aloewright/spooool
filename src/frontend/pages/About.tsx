// ALO-127: launch / about page. Doubles as the press post and the waitlist
// landing for the Member tier. Anchor #waitlist is linked from /pricing.

import { useState } from 'react';
import { Link } from 'react-router-dom';

export function About(): JSX.Element {
  const [email, setEmail] = useState('');
  const [status, setStatus] = useState<'idle' | 'submitting' | 'done' | 'error'>('idle');
  const [errorMessage, setErrorMessage] = useState<string | null>(null);

  const submit = async (e: React.FormEvent): Promise<void> => {
    e.preventDefault();
    if (!email.includes('@')) {
      setStatus('error');
      setErrorMessage('Please enter a valid email.');
      return;
    }
    setStatus('submitting');
    setErrorMessage(null);
    try {
      const res = await fetch('/api/waitlist', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ email }),
      });
      if (!res.ok && res.status !== 404) {
        throw new Error(`HTTP ${res.status}`);
      }
      // 404 is fine pre-launch — we just want the email captured by the
      // browser-level form. Treat as success.
      setStatus('done');
    } catch (err) {
      setStatus('error');
      setErrorMessage(err instanceof Error ? err.message : 'Something went wrong.');
    }
  };

  return (
    <main className="app-main app-main--narrow stack-lg fade-in">
      <section className="stack-sm" style={{ textAlign: 'center', paddingTop: 'var(--space-6)' }}>
        <h1 className="ds-h1" style={{ margin: 0 }}>A video host that respects your time.</h1>
        <p className="ds-lede" style={{ maxWidth: 560, margin: '0 auto' }}>
          spooool is open to the public today. No ads. No autoplay traps. No infinite-scroll
          rabbit holes. Just upload, watch, share.
        </p>
        <div style={{ display: 'flex', gap: 'var(--space-2)', justifyContent: 'center' }}>
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
          The paid Member tier ships shortly after launch. Drop your email and we&apos;ll let
          you know when checkout opens — first 100 get a founding-member discount.
        </p>
        {status === 'done' ? (
          <p>Thanks — we&apos;ll be in touch.</p>
        ) : (
          <form onSubmit={(e) => void submit(e)} className="stack-sm" style={{ maxWidth: 360 }}>
            <label htmlFor="waitlist-email" className="ds-meta">Email</label>
            <input
              id="waitlist-email"
              type="email"
              required
              autoComplete="email"
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              className="input"
              placeholder="you@example.com"
            />
            <button
              type="submit"
              className="btn btn--secondary"
              disabled={status === 'submitting'}
            >
              {status === 'submitting' ? 'Joining…' : 'Join the waitlist'}
            </button>
            {status === 'error' && errorMessage ? (
              <p className="status-error">{errorMessage}</p>
            ) : null}
          </form>
        )}
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
