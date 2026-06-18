// ALO-159: user-facing Report control. Opens a small inline form with a
// reason picker + free-text details, POSTs to /api/reports, and surfaces
// the resulting state inline. The backend already exists from ALO-171
// (moderation queue), so this component is purely the UX surface.

import { useState, type JSX } from 'react';
import { useSession } from '../lib/auth-client';

export type ReportTargetType = 'video' | 'comment';

interface ReportButtonProps {
  targetType: ReportTargetType;
  targetId: string;
  /** Optional override for the trigger button label. */
  label?: string;
  /** Tighter button styling (matches comment row). */
  size?: 'sm' | 'md';
}

// Mirrors the moderation queue's most common report categories without
// hardcoding the full taxonomy — admins can still see the free-text details.
const REPORT_REASONS: Array<{ value: string; label: string }> = [
  { value: 'spam', label: 'Spam or misleading' },
  { value: 'harassment', label: 'Harassment or hate speech' },
  { value: 'sexual', label: 'Sexual or graphic content' },
  { value: 'violence', label: 'Violence or dangerous acts' },
  { value: 'misinformation', label: 'Misinformation' },
  { value: 'copyright', label: 'Copyright (use the DMCA form for formal notices)' },
  { value: 'other', label: 'Other' },
];

const DETAILS_MAX = 2000;

export function ReportButton({
  targetType,
  targetId,
  label = 'Report',
  size = 'sm',
}: ReportButtonProps): JSX.Element {
  const { data: session } = useSession();
  const [open, setOpen] = useState(false);
  const [reason, setReason] = useState<string>(REPORT_REASONS[0].value);
  const [details, setDetails] = useState<string>('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [submitted, setSubmitted] = useState(false);

  const btnClass = size === 'sm' ? 'btn btn--ghost btn--sm' : 'btn btn--ghost';

  if (submitted) {
    return (
      <span className="ds-meta" role="status" aria-live="polite">
        Report submitted — thank you.
      </span>
    );
  }

  if (!session?.user) {
    // Anonymous users can't post reports (the backend rejects with 401);
    // hide the control rather than render an inert button that 401s on click.
    return <></>;
  }

  if (!open) {
    return (
      <button type="button" className={btnClass} onClick={() => setOpen(true)}>
        {label}
      </button>
    );
  }

  const submit = async (): Promise<void> => {
    setBusy(true);
    setError(null);
    try {
      const res = await fetch('/api/reports', {
        method: 'POST',
        credentials: 'same-origin',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ targetType, targetId, reason, details }),
      });
      if (res.status === 401) {
        setError('Sign in required to report content.');
        return;
      }
      if (res.status === 404) {
        setError('Target not found.');
        return;
      }
      if (!res.ok) {
        const body = (await res.json().catch(() => null)) as { error?: string } | null;
        setError(body?.error ?? 'Failed to submit report.');
        return;
      }
      setSubmitted(true);
    } catch {
      setError('Failed to submit report.');
    } finally {
      setBusy(false);
    }
  };

  return (
    <div
      className="stack-sm"
      role="dialog"
      aria-label={`Report this ${targetType}`}
      style={{
        padding: 'var(--space-2) var(--space-3)',
        border: '1px solid var(--border)',
        borderRadius: 'var(--radius-md)',
        maxWidth: 480,
      }}
    >
      <label className="ds-meta" style={{ display: 'block' }}>
        Reason
        <select
          className="input"
          value={reason}
          onChange={(e) => setReason(e.target.value)}
          disabled={busy}
          style={{ display: 'block', marginTop: 'var(--space-1)' }}
        >
          {REPORT_REASONS.map((r) => (
            <option key={r.value} value={r.value}>
              {r.label}
            </option>
          ))}
        </select>
      </label>
      <label className="ds-meta" style={{ display: 'block' }}>
        Details (optional)
        <textarea
          className="input"
          rows={3}
          maxLength={DETAILS_MAX}
          value={details}
          onChange={(e) => setDetails(e.target.value)}
          disabled={busy}
          placeholder="What's wrong? Anything our moderators should know."
          style={{ display: 'block', marginTop: 'var(--space-1)' }}
        />
      </label>
      <div className="row" style={{ gap: 'var(--space-2)' }}>
        <button
          type="button"
          className="btn btn--sm"
          onClick={() => {
            void submit();
          }}
          disabled={busy}
        >
          {busy ? 'Submitting…' : 'Submit report'}
        </button>
        <button
          type="button"
          className="btn btn--ghost btn--sm"
          onClick={() => {
            setOpen(false);
            setError(null);
          }}
          disabled={busy}
        >
          Cancel
        </button>
      </div>
      {error ? (
        <p className="status-error" role="alert">
          {error}
        </p>
      ) : null}
    </div>
  );
}
