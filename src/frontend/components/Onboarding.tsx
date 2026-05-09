// ALO-127 — first-run onboarding modal. Shown to a freshly-created session
// once, then suppressed via localStorage. The trigger is set explicitly by
// the signup page rather than auto-detected from session age so a returning
// user clearing cookies doesn't get re-onboarded.

import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';

const STORAGE_KEY = 'spooool:onboarded-at';
const TRIGGER_KEY = 'spooool:onboarding-pending';

interface Step {
  title: string;
  body: string;
  cta: { label: string; to: string };
}

const STEPS: Step[] = [
  {
    title: 'Welcome to spooool',
    body: "It's a quiet corner of the web for video. No ads, no infinite scroll, no recommendations engine reaching for your sleeve.",
    cta: { label: 'Next', to: '#step-2' },
  },
  {
    title: 'Upload your first video',
    body: 'Drop in an MP4 or MOV file. We encode automatically and most clips are streamable in under a minute.',
    cta: { label: 'Upload now', to: '/upload' },
  },
  {
    title: 'Make it yours',
    body: "Set a display name and avatar so viewers know who's behind the videos. You can change it any time.",
    cta: { label: 'Open profile', to: '/profile' },
  },
];

export function Onboarding(): JSX.Element | null {
  const [open, setOpen] = useState(false);
  const [step, setStep] = useState(0);

  useEffect(() => {
    if (typeof window === 'undefined') return;
    try {
      const done = window.localStorage.getItem(STORAGE_KEY);
      const pending = window.localStorage.getItem(TRIGGER_KEY);
      if (!done && pending === '1') setOpen(true);
    } catch {
      // localStorage blocked — treat as non-pending; user can still discover
      // the upload flow via the header.
    }
  }, []);

  function dismiss(): void {
    setOpen(false);
    try {
      window.localStorage.setItem(STORAGE_KEY, String(Date.now()));
      window.localStorage.removeItem(TRIGGER_KEY);
    } catch {
      // Ignore — at worst we re-show on the next visit.
    }
  }

  if (!open) return null;
  const current = STEPS[step];
  const isLast = step === STEPS.length - 1;

  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-labelledby="onboarding-title"
      style={{
        position: 'fixed',
        inset: 0,
        zIndex: 60,
        background: 'oklch(0 0 0 / 0.45)',
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        padding: 'var(--space-4)',
      }}
    >
      <div
        className="card stack"
        style={{
          width: '100%',
          maxWidth: 480,
          background: 'var(--card)',
          boxShadow: 'var(--shadow-float)',
        }}
      >
        <div className="stack-sm">
          <span className="ds-label">Step {step + 1} of {STEPS.length}</span>
          <h2 id="onboarding-title" className="ds-h2" style={{ margin: 0 }}>
            {current.title}
          </h2>
          <p>{current.body}</p>
        </div>
        <div
          className="row"
          style={{ justifyContent: 'space-between', alignItems: 'center' }}
        >
          <button type="button" className="btn btn--ghost btn--sm" onClick={dismiss}>
            Skip
          </button>
          <div className="row" style={{ gap: 8 }}>
            {step > 0 ? (
              <button
                type="button"
                className="btn btn--secondary btn--sm"
                onClick={() => setStep((s) => Math.max(0, s - 1))}
              >
                Back
              </button>
            ) : null}
            {isLast ? (
              <Link to={current.cta.to} onClick={dismiss}>
                <button type="button" className="btn btn--sm">{current.cta.label}</button>
              </Link>
            ) : (
              <button
                type="button"
                className="btn btn--sm"
                onClick={() => setStep((s) => Math.min(STEPS.length - 1, s + 1))}
              >
                Next
              </button>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}

// Set this immediately after signup so the modal opens on the next route the
// user lands on. Exposed as a free function so the signup page doesn't need
// to import the component itself.
export function markOnboardingPending(): void {
  if (typeof window === 'undefined') return;
  try {
    window.localStorage.setItem(TRIGGER_KEY, '1');
  } catch {
    // Best-effort.
  }
}
