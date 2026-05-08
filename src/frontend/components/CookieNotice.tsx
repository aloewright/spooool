// ALO-127: minimal cookie notice. We use first-party analytics only and
// strictly necessary auth cookies, but the banner is required for EU/UK
// visitors and good practice everywhere. Stored choice lives in
// localStorage under `cookie-notice-ack` so the banner stays dismissed
// across reloads and browsing sessions on the same device.

import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';

const STORAGE_KEY = 'cookie-notice-ack';

export function CookieNotice(): JSX.Element | null {
  const [show, setShow] = useState(false);

  useEffect(() => {
    if (typeof window === 'undefined') return;
    try {
      const ack = window.localStorage.getItem(STORAGE_KEY);
      if (!ack) setShow(true);
    } catch {
      // Private mode / disabled storage — show the notice each visit; harmless.
      setShow(true);
    }
  }, []);

  if (!show) return null;

  const dismiss = (): void => {
    try {
      window.localStorage.setItem(STORAGE_KEY, '1');
    } catch {
      // ignore — the in-memory state below is the user-facing dismissal.
    }
    setShow(false);
  };

  return (
    <div
      role="region"
      aria-label="Cookie notice"
      style={{
        position: 'fixed',
        left: 'var(--space-3)',
        right: 'var(--space-3)',
        bottom: 'var(--space-3)',
        zIndex: 60,
        maxWidth: 560,
        marginLeft: 'auto',
        marginRight: 'auto',
        padding: 'var(--space-3)',
        background: 'var(--surface)',
        border: '1px solid var(--border)',
        borderRadius: 12,
        boxShadow: '0 8px 24px rgba(0,0,0,0.15)',
        display: 'flex',
        flexWrap: 'wrap',
        gap: 'var(--space-2)',
        alignItems: 'center',
        justifyContent: 'space-between',
      }}
    >
      <p className="ds-meta" style={{ margin: 0, flex: '1 1 240px' }}>
        We use cookies for sign-in and first-party product analytics. No ad networks. See our{' '}
        <Link to="/legal/privacy">Privacy Policy</Link>.
      </p>
      <button type="button" className="btn btn--secondary btn--sm" onClick={dismiss}>
        Got it
      </button>
    </div>
  );
}
