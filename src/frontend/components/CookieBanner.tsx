import { useEffect, useState, type JSX } from 'react';
import { Link } from '@tanstack/react-router';

const CONSENT_KEY = 'cookie-consent:v1';

export type ConsentValue = 'accepted' | 'declined';

export function getStoredConsent(): ConsentValue | null {
  try {
    const v = window.localStorage.getItem(CONSENT_KEY);
    if (v === 'accepted' || v === 'declined') return v;
    return null;
  } catch {
    return null;
  }
}

export function setStoredConsent(value: ConsentValue): void {
  try {
    window.localStorage.setItem(CONSENT_KEY, value);
  } catch {
    // Private mode / storage disabled — ignore.
  }
}

export function CookieBanner(): JSX.Element | null {
  const [visible, setVisible] = useState(false);

  useEffect(() => {
    // Show only when no prior choice is stored. Wait one tick so the app
    // can check consent and init analytics before we potentially show.
    if (getStoredConsent() === null) {
      setVisible(true);
    }
  }, []);

  if (!visible) return null;

  const handleAccept = (): void => {
    setStoredConsent('accepted');
    setVisible(false);
    // Fire analytics init now that we have consent.
    void import('../lib/analytics').then(({ initAnalytics }) => initAnalytics()).catch(() => undefined);
  };

  const handleDecline = (): void => {
    setStoredConsent('declined');
    setVisible(false);
  };

  return (
    <div
      role="dialog"
      aria-label="Cookie preferences"
      style={{
        position: 'fixed',
        bottom: 'var(--space-4)',
        left: '50%',
        transform: 'translateX(-50%)',
        width: 'min(560px, calc(100vw - var(--space-8)))',
        zIndex: 9999,
        background: 'var(--surface)',
        border: '1px solid var(--border)',
        borderRadius: 'var(--radius-lg)',
        boxShadow: 'var(--shadow-float)',
        padding: 'var(--space-4)',
        display: 'flex',
        gap: 'var(--space-3)',
        alignItems: 'flex-start',
      }}
    >
      <div style={{ flex: 1 }}>
        <p style={{ margin: 0, fontSize: 'var(--text-sm)' }}>
          We use analytics cookies to understand how spooool is used and improve the experience.
          See our{' '}
          <Link to="/legal/privacy" style={{ textDecoration: 'underline' }}>
            Privacy Policy
          </Link>{' '}
          for details.
        </p>
      </div>
      <div style={{ display: 'flex', gap: 'var(--space-2)', flexShrink: 0 }}>
        <button
          type="button"
          className="btn btn--ghost btn--sm"
          onClick={handleDecline}
        >
          Decline
        </button>
        <button
          type="button"
          className="btn btn--sm"
          onClick={handleAccept}
        >
          Accept
        </button>
      </div>
    </div>
  );
}
