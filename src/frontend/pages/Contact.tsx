import { FormEvent, useState } from 'react';
import { Link } from 'react-router-dom';

type Category = { value: string; label: string };

const CATEGORIES: Category[] = [
  { value: 'general', label: 'General question' },
  { value: 'upload', label: 'Upload or playback issue' },
  { value: 'account', label: 'Account or billing' },
  { value: 'dmca', label: 'Copyright / DMCA' },
  { value: 'other', label: 'Something else' },
];

export function Contact(): JSX.Element {
  const [category, setCategory] = useState('general');
  const [email, setEmail] = useState('');
  const [message, setMessage] = useState('');
  const [state, setState] = useState<'idle' | 'submitting' | 'done' | 'error'>('idle');
  const [errorMsg, setErrorMsg] = useState('');

  async function onSubmit(e: FormEvent<HTMLFormElement>): Promise<void> {
    e.preventDefault();
    setState('submitting');
    setErrorMsg('');
    try {
      const res = await fetch('/api/contact', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ email, category, message }),
      });
      if (!res.ok) {
        const data = await res.json().catch(() => ({})) as { error?: string };
        throw new Error(data.error ?? `Request failed (${res.status})`);
      }
      setState('done');
    } catch (err: unknown) {
      setErrorMsg(err instanceof Error ? err.message : 'Something went wrong — try again.');
      setState('error');
    }
  }

  return (
    <main className="app-main app-main--narrow stack-lg fade-in" style={{ paddingTop: 'var(--space-8)' }}>
      <section className="stack-sm" style={{ textAlign: 'center' }}>
        <span className="ds-label">Support</span>
        <h1 className="ds-h2">Contact us</h1>
        <p className="ds-lede" style={{ maxWidth: 480, margin: '0 auto' }}>
          We usually respond within one business day. For faster answers, check the{' '}
          <Link to="/help" className="ds-link">Help Center</Link> first.
        </p>
      </section>

      {state === 'done' ? (
        <section className="card stack-sm" style={{ textAlign: 'center', padding: 'var(--space-6)' }}>
          <div style={{ fontSize: 'var(--text-2xl)' }}>✓</div>
          <h2 className="ds-h3">Message received</h2>
          <p className="ds-meta">
            We'll reply to <strong>{email}</strong> within one business day.
          </p>
          <Link to="/" className="btn btn--secondary" style={{ alignSelf: 'center' }}>
            Back to home
          </Link>
        </section>
      ) : (
        <form className="card stack" onSubmit={(e) => void onSubmit(e)}>
          <div className="stack-sm">
            <label htmlFor="ct-category" className="ds-label">Topic</label>
            <select
              id="ct-category"
              className="input"
              value={category}
              onChange={(e) => setCategory(e.target.value)}
            >
              {CATEGORIES.map((c) => (
                <option key={c.value} value={c.value}>{c.label}</option>
              ))}
            </select>
          </div>

          <div className="stack-sm">
            <label htmlFor="ct-email" className="ds-label">Your email</label>
            <input
              id="ct-email"
              type="email"
              className="input"
              placeholder="you@example.com"
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              required
              maxLength={254}
              autoComplete="email"
            />
          </div>

          <div className="stack-sm">
            <label htmlFor="ct-message" className="ds-label">Message</label>
            <textarea
              id="ct-message"
              className="input"
              placeholder="Describe the issue or question…"
              value={message}
              onChange={(e) => setMessage(e.target.value)}
              required
              minLength={10}
              maxLength={4000}
              rows={6}
              style={{ resize: 'vertical' }}
            />
          </div>

          {state === 'error' && (
            <p role="alert" className="status-error">{errorMsg}</p>
          )}

          <button type="submit" className="btn" disabled={state === 'submitting'}>
            {state === 'submitting' ? 'Sending…' : 'Send message'}
          </button>

          <p className="ds-meta" style={{ textAlign: 'center' }}>
            For DMCA notices use the{' '}
            <Link to="/legal/dmca" className="ds-link">DMCA form</Link> instead.
          </p>
        </form>
      )}

      <section className="stack-sm">
        <h2 className="ds-h3">Other ways to reach us</h2>
        <div
          style={{
            display: 'grid',
            gridTemplateColumns: 'repeat(auto-fit, minmax(220px, 1fr))',
            gap: 'var(--space-3)',
          }}
        >
          <article className="card stack-sm">
            <strong>Email</strong>
            <p className="ds-meta" style={{ margin: 0 }}>
              <a href="mailto:support@spooool.com" className="ds-link">
                support@spooool.com
              </a>
            </p>
          </article>
          <article className="card stack-sm">
            <strong>Help Center</strong>
            <p className="ds-meta" style={{ margin: 0 }}>
              <Link to="/help" className="ds-link">Browse articles and guides →</Link>
            </p>
          </article>
          <article className="card stack-sm">
            <strong>Status</strong>
            <p className="ds-meta" style={{ margin: 0 }}>
              <Link to="/status" className="ds-link">Check platform status →</Link>
            </p>
          </article>
        </div>
      </section>
    </main>
  );
}
