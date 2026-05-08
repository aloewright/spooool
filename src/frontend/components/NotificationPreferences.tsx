// ALO-157: notification preferences card on the account settings page.
// Today this is just the email digest cadence; we route the section under
// the `#notifications` hash so the bell popover's "Settings" link can
// scroll the user straight to it.

import { useEffect, useRef, useState } from 'react';

type Frequency = 'off' | 'daily' | 'weekly';

interface PreferencesResponse {
  emailDigestFrequency: Frequency;
  emailDigestLastSentAt: number | null;
}

const OPTIONS: { value: Frequency; label: string; description: string }[] = [
  { value: 'weekly', label: 'Weekly', description: 'One email per week summarising new uploads from creators you follow.' },
  { value: 'daily', label: 'Daily', description: 'A daily round-up — only sent on days something new is posted.' },
  { value: 'off', label: 'Off', description: 'No email digests. The in-app bell still works.' },
];

export function NotificationPreferences(): JSX.Element {
  const [frequency, setFrequency] = useState<Frequency | null>(null);
  const [lastSentAt, setLastSentAt] = useState<number | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [info, setInfo] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const sectionRef = useRef<HTMLElement | null>(null);

  useEffect(() => {
    let cancelled = false;
    void fetch('/api/users/me/notifications/preferences', { credentials: 'same-origin' })
      .then(async (r) => {
        if (!r.ok) throw new Error(`Preferences fetch failed: ${r.status}`);
        return (await r.json()) as PreferencesResponse;
      })
      .then((data) => {
        if (cancelled) return;
        setFrequency(data.emailDigestFrequency);
        setLastSentAt(data.emailDigestLastSentAt);
      })
      .catch((err: unknown) => {
        if (!cancelled) setError(err instanceof Error ? err.message : 'Unknown error');
      });
    return () => {
      cancelled = true;
    };
  }, []);

  // Scroll to this section if the page was opened with #notifications (e.g.
  // from the bell popover's "Settings" link). useEffect runs after layout so
  // the element exists.
  useEffect(() => {
    if (typeof window === 'undefined') return;
    if (window.location.hash === '#notifications' && sectionRef.current) {
      sectionRef.current.scrollIntoView({ behavior: 'smooth', block: 'start' });
    }
  }, [frequency]);

  const update = async (next: Frequency): Promise<void> => {
    setBusy(true);
    setError(null);
    setInfo(null);
    try {
      const r = await fetch('/api/users/me/notifications/preferences', {
        method: 'PUT',
        credentials: 'same-origin',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ emailDigestFrequency: next }),
      });
      if (!r.ok) throw new Error(((await r.json()) as { error?: string }).error ?? `HTTP ${r.status}`);
      setFrequency(next);
      setInfo(next === 'off' ? 'Email digest off.' : `Email digest set to ${next}.`);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to update preference');
    } finally {
      setBusy(false);
    }
  };

  return (
    <section
      ref={sectionRef}
      id="notifications"
      className="stack-sm"
      aria-label="Notifications"
    >
      <span className="ds-label">Notifications</span>
      <p className="ds-meta">
        We&apos;ll email you a digest of new uploads from creators you follow. The in-app bell shows
        unread items in real time.
      </p>
      {error && <p className="status-error">{error}</p>}
      {info && <p className="ds-meta">{info}</p>}
      <div role="radiogroup" aria-label="Email digest frequency" className="stack-sm">
        {OPTIONS.map((opt) => (
          <label
            key={opt.value}
            style={{
              display: 'flex',
              alignItems: 'flex-start',
              gap: 'var(--space-2)',
              padding: 'var(--space-2)',
              borderRadius: 6,
              border: '1px solid var(--border, #eee)',
              cursor: busy ? 'progress' : 'pointer',
              opacity: frequency === null ? 0.6 : 1,
            }}
          >
            <input
              type="radio"
              name="email-digest-frequency"
              value={opt.value}
              checked={frequency === opt.value}
              disabled={busy || frequency === null}
              onChange={() => void update(opt.value)}
              style={{ marginTop: 2 }}
            />
            <span>
              <strong style={{ display: 'block' }}>{opt.label}</strong>
              <span className="ds-meta">{opt.description}</span>
            </span>
          </label>
        ))}
      </div>
      {lastSentAt && frequency !== 'off' ? (
        <p className="ds-meta">
          Last digest sent {new Date(lastSentAt).toLocaleString()}.
        </p>
      ) : null}
    </section>
  );
}
