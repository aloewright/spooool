import { useState, type JSX } from 'react';
import { useSession } from '../lib/auth-client';

// LEGAL-REVIEW: counter-notice form labels and consent statement must match
// 17 U.S.C. § 512(g)(3) before launch. Strings are placeholders.

export function DmcaCounter(): JSX.Element {
  const { data: session, isPending } = useSession();
  const [claimId, setClaimId] = useState('');
  const [name, setName] = useState('');
  const [address, setAddress] = useState('');
  const [phone, setPhone] = useState('');
  const [email, setEmail] = useState('');
  const [statement, setStatement] = useState('');
  const [signature, setSignature] = useState('');
  const [consent, setConsent] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [submittedId, setSubmittedId] = useState<string | null>(null);

  const submit = async (e: React.FormEvent): Promise<void> => {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      const r = await fetch('/api/dmca/counter', {
        method: 'POST',
        credentials: 'include',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          claimId,
          uploaderName: name,
          uploaderAddress: address,
          uploaderPhone: phone,
          uploaderEmail: email,
          statement,
          signature,
          consentToJurisdiction: consent,
        }),
      });
      if (!r.ok) throw new Error(((await r.json()) as { error: string }).error);
      const data = (await r.json()) as { id: string };
      setSubmittedId(data.id);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Submission failed');
    } finally {
      setBusy(false);
    }
  };

  if (isPending) return <main className="app-main stack"><p className="ds-empty">Loading…</p></main>;
  if (!session) {
    return (
      <main className="app-main stack">
        <p className="ds-empty">Sign in required to submit a counter-notice.</p>
      </main>
    );
  }
  if (submittedId) {
    return (
      <main className="app-main stack-lg">
        <h1 className="ds-h2">Counter-notice received</h1>
        {/* LEGAL-REVIEW: confirm 10-14 business day waiting language. */}
        <p className="ds-meta">
          Reference: <code>{submittedId}</code>. Your video will be restored after the statutory waiting period if no
          court order is filed.
        </p>
      </main>
    );
  }

  return (
    <main className="app-main stack-lg">
      <header className="stack-sm">
        <h1 className="ds-h2">DMCA counter-notice</h1>
        {/* LEGAL-REVIEW: § 512(g) — counter-notification copy. */}
        <p className="ds-lede">
          File this if you believe your video was disabled in error. False statements may carry legal consequences.
        </p>
      </header>

      {error && <p className="status-error">{error}</p>}

      <form className="stack-sm" onSubmit={(e) => void submit(e)}>
        <label className="stack-sm">
          <span className="ds-label">Claim id</span>
          <input className="input" value={claimId} onChange={(e) => setClaimId(e.target.value)} required />
        </label>
        <label className="stack-sm">
          <span className="ds-label">Your full name</span>
          <input className="input" value={name} onChange={(e) => setName(e.target.value)} required />
        </label>
        <label className="stack-sm">
          <span className="ds-label">Mailing address</span>
          <textarea className="input" value={address} onChange={(e) => setAddress(e.target.value)} required />
        </label>
        <label className="stack-sm">
          <span className="ds-label">Phone</span>
          <input className="input" value={phone} onChange={(e) => setPhone(e.target.value)} required />
        </label>
        <label className="stack-sm">
          <span className="ds-label">Email</span>
          <input className="input" type="email" value={email} onChange={(e) => setEmail(e.target.value)} required />
        </label>
        <label className="stack-sm">
          <span className="ds-label">Statement explaining good-faith belief of error</span>
          <textarea className="input" value={statement} onChange={(e) => setStatement(e.target.value)} required />
        </label>
        <label style={{ display: 'flex', gap: 'var(--space-2)' }}>
          <input type="checkbox" checked={consent} onChange={(e) => setConsent(e.target.checked)} required />
          {/* LEGAL-REVIEW: § 512(g)(3)(D) — consent to federal court jurisdiction. */}
          <span className="ds-meta">
            I consent to the jurisdiction of the federal district court for my address (or, outside the U.S., any
            district in which the service provider may be found).
          </span>
        </label>
        <label className="stack-sm">
          <span className="ds-label">Electronic signature (your full name)</span>
          <input className="input" value={signature} onChange={(e) => setSignature(e.target.value)} required />
        </label>
        <button type="submit" className="btn btn--secondary" disabled={busy}>
          Submit counter-notice
        </button>
      </form>
    </main>
  );
}
