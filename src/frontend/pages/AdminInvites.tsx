import { FormEvent, useEffect, useState } from 'react';

type WaitlistEntry = {
  id: string;
  email: string;
  status: string;
  invite_code: string | null;
  created_at: number;
  invited_at: number | null;
};

type InviteCode = {
  code: string;
  wave: number;
  max_uses: number;
  used_count: number;
  note: string | null;
  expires_at: number | null;
  created_at: number;
  created_by_email: string | null;
};

type Tab = 'waitlist' | 'codes';

export function AdminInvites(): JSX.Element {
  const [tab, setTab] = useState<Tab>('waitlist');

  return (
    <main className="app-main app-main--narrow stack-lg fade-in">
      <div className="stack-sm" style={{ paddingTop: 'var(--space-8)', paddingBottom: 'var(--space-3)' }}>
        <span className="ds-label">Admin</span>
        <h1 className="ds-h2">Beta invites</h1>
      </div>

      <div className="row" style={{ gap: 'var(--space-2)' }}>
        <button
          type="button"
          className={tab === 'waitlist' ? 'btn btn--sm' : 'btn btn--ghost btn--sm'}
          onClick={() => setTab('waitlist')}
        >
          Waitlist
        </button>
        <button
          type="button"
          className={tab === 'codes' ? 'btn btn--sm' : 'btn btn--ghost btn--sm'}
          onClick={() => setTab('codes')}
        >
          Invite codes
        </button>
      </div>

      {tab === 'waitlist' ? <WaitlistPanel /> : <CodesPanel />}
    </main>
  );
}

function WaitlistPanel(): JSX.Element {
  const [entries, setEntries] = useState<WaitlistEntry[]>([]);
  const [total, setTotal] = useState(0);
  const [statusFilter, setStatusFilter] = useState('pending');
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [sending, setSending] = useState(false);
  const [sendResult, setSendResult] = useState<string | null>(null);
  const [refreshKey, setRefreshKey] = useState(0);

  useEffect(() => {
    setLoading(true);
    setSelected(new Set());
    setError(null);
    void fetch(`/api/admin/waitlist?status=${statusFilter}&limit=100`, { credentials: 'same-origin' })
      .then(async (res) => {
        if (!res.ok) throw new Error('Failed to load waitlist');
        const data = (await res.json()) as { entries: WaitlistEntry[]; total: number };
        setEntries(data.entries);
        setTotal(data.total);
      })
      .catch((e: unknown) => setError(e instanceof Error ? e.message : 'Error'))
      .finally(() => setLoading(false));
  }, [statusFilter, refreshKey]);

  function toggleAll(): void {
    if (selected.size === entries.length) {
      setSelected(new Set());
    } else {
      setSelected(new Set(entries.map((e) => e.email)));
    }
  }

  async function sendInvites(e: FormEvent): Promise<void> {
    e.preventDefault();
    if (selected.size === 0) return;
    setSending(true);
    setSendResult(null);
    try {
      const res = await fetch('/api/admin/waitlist/invite', {
        method: 'POST',
        credentials: 'same-origin',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ emails: Array.from(selected), wave: sendingWave }),
      });
      const data = (await res.json()) as { ok?: boolean; sent?: number; errors?: string[]; error?: string };
      if (!res.ok) {
        setSendResult(`Error: ${data.error ?? 'Unknown'}`);
        return;
      }
      setSendResult(`Sent ${data.sent ?? 0} invite(s)${data.errors?.length ? ` (${data.errors.length} failed)` : ''}`);
      // Refresh list
      setRefreshKey((k) => k + 1);
    } catch {
      setSendResult('Network error');
    } finally {
      setSending(false);
    }
  }

  return (
    <div className="stack">
      <div className="row" style={{ justifyContent: 'space-between', alignItems: 'center' }}>
        <span className="ds-meta">{total} total</span>
        <select
          className="input input--sm"
          value={statusFilter}
          onChange={(e) => setStatusFilter(e.target.value)}
          style={{ width: 'auto' }}
        >
          <option value="pending">Pending</option>
          <option value="invited">Invited</option>
          <option value="joined">Joined</option>
        </select>
      </div>

      {error ? <p className="status-error">{error}</p> : null}
      {loading ? <p className="ds-meta">Loading…</p> : null}

      {!loading && entries.length === 0 ? (
        <p className="ds-empty">No {statusFilter} entries.</p>
      ) : null}

      {entries.length > 0 ? (
        <>
          <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 'var(--text-sm)' }}>
            <thead>
              <tr>
                <th style={{ textAlign: 'left', padding: '4px 8px' }}>
                  <input type="checkbox" checked={selected.size === entries.length} onChange={toggleAll} />
                </th>
                <th style={{ textAlign: 'left', padding: '4px 8px' }}>Email</th>
                <th style={{ textAlign: 'left', padding: '4px 8px' }}>Status</th>
                <th style={{ textAlign: 'left', padding: '4px 8px' }}>Joined</th>
              </tr>
            </thead>
            <tbody>
              {entries.map((entry) => (
                <tr key={entry.id} style={{ borderTop: '1px solid var(--border)' }}>
                  <td style={{ padding: '4px 8px' }}>
                    {entry.status === 'pending' ? (
                      <input
                        type="checkbox"
                        checked={selected.has(entry.email)}
                        onChange={(ev) => {
                          const next = new Set(selected);
                          if (ev.target.checked) next.add(entry.email);
                          else next.delete(entry.email);
                          setSelected(next);
                        }}
                      />
                    ) : null}
                  </td>
                  <td style={{ padding: '4px 8px' }}>{entry.email}</td>
                  <td style={{ padding: '4px 8px' }}>{entry.status}</td>
                  <td style={{ padding: '4px 8px' }} className="ds-meta">
                    {new Date(entry.created_at).toLocaleDateString()}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>

          {statusFilter === 'pending' ? (
            <form onSubmit={(e) => void sendInvites(e)} className="card row" style={{ alignItems: 'center', gap: 'var(--space-3)' }}>
              <span className="ds-meta">{selected.size} selected</span>
              <label className="ds-meta row" style={{ gap: 'var(--space-2)', alignItems: 'center' }}>
                Wave
                <input
                  type="number"
                  className="input input--sm"
                  value={sendingWave}
                  min={1}
                  onChange={(e) => setSendingWave(parseInt(e.target.value, 10) || 1)}
                  style={{ width: 64 }}
                />
              </label>
              <button type="submit" className="btn btn--sm" disabled={sending || selected.size === 0}>
                {sending ? 'Sending…' : `Send ${selected.size} invite(s)`}
              </button>
              {sendResult ? <span className="ds-meta">{sendResult}</span> : null}
            </form>
          ) : null}
        </>
      ) : null}
    </div>
  );
}

function CodesPanel(): JSX.Element {
  const [codes, setCodes] = useState<InviteCode[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [count, setCount] = useState(1);
  const [wave, setWave] = useState(1);
  const [maxUses, setMaxUses] = useState(1);
  const [note, setNote] = useState('');
  const [generating, setGenerating] = useState(false);
  const [genResult, setGenResult] = useState<string[] | null>(null);

  function loadCodes(): void {
    setLoading(true);
    void fetch('/api/admin/invite-codes?limit=200', { credentials: 'same-origin' })
      .then(async (res) => {
        if (!res.ok) throw new Error('Failed to load codes');
        const data = (await res.json()) as { codes: InviteCode[] };
        setCodes(data.codes);
      })
      .catch((e: unknown) => setError(e instanceof Error ? e.message : 'Error'))
      .finally(() => setLoading(false));
  }

  useEffect(() => { loadCodes(); }, []);

  async function generate(e: FormEvent): Promise<void> {
    e.preventDefault();
    setGenerating(true);
    setGenResult(null);
    try {
      const res = await fetch('/api/admin/invite-codes', {
        method: 'POST',
        credentials: 'same-origin',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ count, wave, maxUses, note: note || undefined }),
      });
      const data = (await res.json()) as { ok?: boolean; codes?: string[]; error?: string };
      if (!res.ok) {
        setError(data.error ?? 'Failed to generate');
        return;
      }
      setGenResult(data.codes ?? []);
      loadCodes();
    } catch {
      setError('Network error');
    } finally {
      setGenerating(false);
    }
  }

  return (
    <div className="stack">
      <form onSubmit={(e) => void generate(e)} className="card stack-sm">
        <span className="ds-label">Generate codes</span>
        <div className="row" style={{ gap: 'var(--space-3)', flexWrap: 'wrap' }}>
          <label className="ds-meta row" style={{ gap: 'var(--space-2)', alignItems: 'center' }}>
            Count
            <input
              type="number"
              className="input input--sm"
              value={count}
              min={1}
              max={200}
              onChange={(e) => setCount(parseInt(e.target.value, 10) || 1)}
              style={{ width: 72 }}
            />
          </label>
          <label className="ds-meta row" style={{ gap: 'var(--space-2)', alignItems: 'center' }}>
            Wave
            <input
              type="number"
              className="input input--sm"
              value={wave}
              min={1}
              onChange={(e) => setWave(parseInt(e.target.value, 10) || 1)}
              style={{ width: 72 }}
            />
          </label>
          <label className="ds-meta row" style={{ gap: 'var(--space-2)', alignItems: 'center' }}>
            Max uses
            <input
              type="number"
              className="input input--sm"
              value={maxUses}
              min={1}
              onChange={(e) => setMaxUses(parseInt(e.target.value, 10) || 1)}
              style={{ width: 72 }}
            />
          </label>
          <label className="ds-meta row" style={{ gap: 'var(--space-2)', alignItems: 'center' }}>
            Note
            <input
              className="input input--sm"
              type="text"
              value={note}
              onChange={(e) => setNote(e.target.value)}
              placeholder="optional label"
              style={{ width: 160 }}
            />
          </label>
        </div>
        <div>
          <button type="submit" className="btn btn--sm" disabled={generating}>
            {generating ? 'Generating…' : 'Generate'}
          </button>
        </div>
        {genResult ? (
          <div className="stack-sm">
            <span className="ds-meta">Generated {genResult.length} code(s):</span>
            <pre style={{ fontFamily: 'monospace', fontSize: 'var(--text-sm)', whiteSpace: 'pre-wrap', wordBreak: 'break-all' }}>
              {genResult.join('\n')}
            </pre>
          </div>
        ) : null}
      </form>

      {error ? <p className="status-error">{error}</p> : null}
      {loading ? <p className="ds-meta">Loading…</p> : null}

      {!loading && codes.length === 0 ? (
        <p className="ds-empty">No invite codes yet.</p>
      ) : null}

      {codes.length > 0 ? (
        <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 'var(--text-sm)' }}>
          <thead>
            <tr>
              <th style={{ textAlign: 'left', padding: '4px 8px' }}>Code</th>
              <th style={{ textAlign: 'left', padding: '4px 8px' }}>Wave</th>
              <th style={{ textAlign: 'left', padding: '4px 8px' }}>Uses</th>
              <th style={{ textAlign: 'left', padding: '4px 8px' }}>Note</th>
              <th style={{ textAlign: 'left', padding: '4px 8px' }}>Created</th>
            </tr>
          </thead>
          <tbody>
            {codes.map((c) => (
              <tr key={c.code} style={{ borderTop: '1px solid var(--border)' }}>
                <td style={{ padding: '4px 8px', fontFamily: 'monospace' }}>{c.code}</td>
                <td style={{ padding: '4px 8px' }}>{c.wave}</td>
                <td style={{ padding: '4px 8px' }}>{c.used_count}/{c.max_uses}</td>
                <td style={{ padding: '4px 8px' }} className="ds-meta">{c.note ?? '—'}</td>
                <td style={{ padding: '4px 8px' }} className="ds-meta">
                  {new Date(c.created_at).toLocaleDateString()}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      ) : null}
    </div>
  );
}
