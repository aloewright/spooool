import { useState, type JSX } from 'react';

// Strings comply with 17 U.S.C. § 512(c)(3)(A). See ALO-170.

interface SubmissionResult {
  id: string;
  status: string;
}

export function DmcaForm(): JSX.Element {
  const [videoId, setVideoId] = useState('');
  const [complainantName, setComplainantName] = useState('');
  const [complainantEmail, setComplainantEmail] = useState('');
  const [complainantAddress, setComplainantAddress] = useState('');
  const [complainantPhone, setComplainantPhone] = useState('');
  const [copyrightedWork, setCopyrightedWork] = useState('');
  const [infringingUrls, setInfringingUrls] = useState('');
  const [goodFaith, setGoodFaith] = useState(false);
  const [perjury, setPerjury] = useState(false);
  const [signature, setSignature] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [submitted, setSubmitted] = useState<SubmissionResult | null>(null);

  const submit = async (e: React.FormEvent): Promise<void> => {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      const urls = infringingUrls
        .split(/\s+/)
        .map((s) => s.trim())
        .filter(Boolean);
      const r = await fetch('/api/dmca/submission', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          videoId,
          complainantName,
          complainantEmail,
          complainantAddress,
          complainantPhone,
          copyrightedWork,
          infringingUrls: urls,
          goodFaithSigned: goodFaith,
          perjurySigned: perjury,
          signature,
        }),
      });
      if (!r.ok) throw new Error(((await r.json()) as { error: string }).error);
      setSubmitted((await r.json()) as SubmissionResult);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Submission failed');
    } finally {
      setBusy(false);
    }
  };

  if (submitted) {
    return (
      <main className="app-main stack-lg">
        <h1 className="ds-h2">DMCA takedown notice received</h1>
        <p className="ds-meta">
          Your notice has been assigned reference number <code>{submitted.id}</code>. A
          confirmation will be sent to {complainantEmail}. We will act on your notice
          expeditiously in accordance with 17&nbsp;U.S.C.&nbsp;&sect;&nbsp;512.
        </p>
      </main>
    );
  }

  return (
    <main className="app-main stack-lg">
      <header className="stack-sm">
        <h1 className="ds-h2">DMCA takedown notice</h1>
        <p className="ds-lede">
          Use this form to submit a notice of claimed copyright infringement under
          17&nbsp;U.S.C.&nbsp;&sect;&nbsp;512(c)(3). Submitting a notice containing
          materially false information may result in civil or criminal liability under
          17&nbsp;U.S.C.&nbsp;&sect;&nbsp;512(f) and applicable law.
        </p>
      </header>

      {error && <p className="status-error">{error}</p>}

      <form className="stack-sm" onSubmit={(e) => void submit(e)}>
        <label className="stack-sm">
          <span className="ds-label">Video ID (allegedly infringing content)</span>
          <input className="input" value={videoId} onChange={(e) => setVideoId(e.target.value)} required />
        </label>
        <label className="stack-sm">
          <span className="ds-label">Full legal name of copyright owner or authorized agent</span>
          <input className="input" value={complainantName} onChange={(e) => setComplainantName(e.target.value)} required />
        </label>
        <label className="stack-sm">
          <span className="ds-label">Email address</span>
          <input className="input" type="email" value={complainantEmail} onChange={(e) => setComplainantEmail(e.target.value)} required />
        </label>
        <label className="stack-sm">
          <span className="ds-label">Mailing address (street, city, state/province, postal code, country)</span>
          <textarea
            className="input"
            value={complainantAddress}
            onChange={(e) => setComplainantAddress(e.target.value)}
            required
          />
        </label>
        <label className="stack-sm">
          <span className="ds-label">Telephone number</span>
          <input className="input" value={complainantPhone} onChange={(e) => setComplainantPhone(e.target.value)} required />
        </label>
        <label className="stack-sm">
          <span className="ds-label">Identification of the copyrighted work claimed to have been infringed</span>
          <textarea
            className="input"
            value={copyrightedWork}
            onChange={(e) => setCopyrightedWork(e.target.value)}
            required
          />
        </label>
        <label className="stack-sm">
          <span className="ds-label">
            Location(s) of the infringing material — information sufficient to permit us
            to locate the material (one URL per line)
          </span>
          <textarea
            className="input"
            value={infringingUrls}
            onChange={(e) => setInfringingUrls(e.target.value)}
            required
          />
        </label>
        <label style={{ display: 'flex', gap: 'var(--space-2)' }}>
          <input type="checkbox" checked={goodFaith} onChange={(e) => setGoodFaith(e.target.checked)} required />
          <span className="ds-meta">
            I have a good-faith belief that use of the material described above, in the
            manner complained of, is not authorized by the copyright owner, its agent,
            or the law.
          </span>
        </label>
        <label style={{ display: 'flex', gap: 'var(--space-2)' }}>
          <input type="checkbox" checked={perjury} onChange={(e) => setPerjury(e.target.checked)} required />
          <span className="ds-meta">
            I declare under penalty of perjury that the information in this notice is
            accurate and that I am the copyright owner, or am authorized to act on behalf
            of the owner, of an exclusive right that is allegedly infringed.
          </span>
        </label>
        <label className="stack-sm">
          <span className="ds-label">
            Electronic signature of copyright owner or authorized agent (type your full legal name)
          </span>
          <input className="input" value={signature} onChange={(e) => setSignature(e.target.value)} required />
        </label>
        <button type="submit" className="btn btn--secondary" disabled={busy}>
          Submit takedown notice
        </button>
      </form>
    </main>
  );
}
