// ALO-127 — first-visit cookie notice. We don't run third-party ad cookies,
// but PostHog autocapture and the auth session cookie are enough that GDPR
// / CCPA notice is required. The banner is dismissed via localStorage so it
// shows once per browser, not once per session.

import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';

const STORAGE_KEY = 'spooool:cookie-notice-dismissed-at';

export function CookieNotice(): JSX.Element | null {
  // Default to hidden so the banner doesn't flash on every render before
  // localStorage is read; the effect flips it open on first load if needed.
  const [visible, setVisible] = useState(false);

  useEffect(() => {
    if (typeof window === 'undefined') return;
    try {
      const dismissed = window.localStorage.getItem(STORAGE_KEY);
      if (!dismissed) setVisible(true);
    } catch {
      // localStorage may throw in private mode / disabled storage. In that
      // case we'd show the banner every visit, which is the safer default.
      setVisible(true);
    }
  }, []);

  function dismiss(): void {
    setVisible(false);
    try {
      window.localStorage.setItem(STORAGE_KEY, String(Date.now()));
    } catch {
      // Best-effort — if storage is blocked we just won't remember.
    }
  }

  if (!visible) return null;

  return (
    <div
      role="region"
      aria-label="Cookie notice"
      style={{
        position: 'fixed',
        left: 'var(--space-4)',
        right: 'var(--space-4)',
        bottom: 'var(--space-4)',
        zIndex: 50,
        maxWidth: 720,
        margin: '0 auto',
        background: 'var(--card)',
        color: 'var(--card-foreground)',
        border: '1px solid var(--border)',
        borderRadius: 'var(--radius-lg)',
        boxShadow: 'var(--shadow-float)',
        padding: 'var(--space-4) var(--space-5)',
        display: 'grid',
        gridTemplateColumns: '1fr auto',
        gap: 'var(--space-4)',
        alignItems: 'center',
      }}
    >
      <p className="ds-meta" style={{ margin: 0 }}>
        spooool uses essential cookies to keep you signed in, and analytics
        cookies to count how many people watch what. We don&apos;t sell your
        data. <Link to="/legal/privacy">Read our Privacy Policy</Link>.
      </p>
      <button type="button" className="btn btn--secondary btn--sm" onClick={dismiss}>
        Got it
      </button>
    </div>
  );
}
