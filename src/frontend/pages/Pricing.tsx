// ALO-180: Pricing page — free tier vs paid creator membership.
// Copy is provisional; numeric limits mirror current product defaults
// (storage quota, upload size). Real billing wiring lives elsewhere.

import { Link } from 'react-router-dom';

type Tier = {
  name: string;
  price: string;
  cadence: string;
  tagline: string;
  cta: { label: string; to: string };
  highlight?: boolean;
  features: string[];
};

const TIERS: Tier[] = [
  {
    name: 'Free',
    price: '$0',
    cadence: 'forever',
    tagline: 'Everything you need to share a clip with friends.',
    cta: { label: 'Create a free account', to: '/signup' },
    features: [
      '5 GB total storage',
      'Up to 2 GB per upload',
      '1080p streaming',
      'Public + unlisted videos',
      'Basic analytics (views, watch time)',
      'Community support',
    ],
  },
  {
    name: 'Creator',
    price: '$8',
    cadence: 'per month',
    tagline: 'For creators who post regularly and want room to grow.',
    cta: { label: 'Start a Creator membership', to: '/signup?plan=creator' },
    highlight: true,
    features: [
      '500 GB storage',
      'Up to 20 GB per upload',
      '4K streaming + adaptive bitrate',
      'Custom channel branding',
      'Detailed analytics + retention graphs',
      'Custom video thumbnails',
      'Priority transcoding queue',
      'Email support',
    ],
  },
];

const COMPARISON: { feature: string; free: string; creator: string }[] = [
  { feature: 'Storage', free: '5 GB', creator: '500 GB' },
  { feature: 'Per-upload size', free: '2 GB', creator: '20 GB' },
  { feature: 'Max resolution', free: '1080p', creator: '4K' },
  { feature: 'Adaptive bitrate (HLS)', free: '—', creator: 'Yes' },
  { feature: 'Custom thumbnails', free: '—', creator: 'Yes' },
  { feature: 'Channel branding', free: '—', creator: 'Yes' },
  { feature: 'Analytics', free: 'Basic', creator: 'Detailed + retention' },
  { feature: 'Transcoding priority', free: 'Standard', creator: 'Priority' },
  { feature: 'Support', free: 'Community', creator: 'Email' },
];

const FAQ: { q: string; a: string }[] = [
  {
    q: 'Can I start on Free and upgrade later?',
    a: 'Yes. Your videos, channel, and history move with you — upgrading just lifts the limits.',
  },
  {
    q: 'What happens to my videos if I cancel Creator?',
    a: 'Your account drops back to Free. Existing videos keep streaming, but new uploads need to fit within the Free storage quota. Nothing is deleted automatically.',
  },
  {
    q: 'Do you take a cut of creator earnings?',
    a: 'No. spooool is a hosting platform — there is no monetization layer yet, and we do not take a percentage of anything you make off-platform.',
  },
  {
    q: 'Is there a yearly plan?',
    a: 'Not yet. Monthly only while we lock in pricing.',
  },
  {
    q: 'Do you offer refunds?',
    a: 'If something goes wrong in your first 14 days on Creator, email hello@spooool.com and we will sort it out.',
  },
];

export function Pricing(): JSX.Element {
  return (
    <main className="app-main app-main--narrow stack-lg fade-in">
      <section
        className="stack-sm"
        style={{ alignItems: 'center', textAlign: 'center', paddingTop: 'var(--space-6)' }}
      >
        <h1 className="ds-h1" style={{ margin: 0 }}>
          Simple pricing
        </h1>
        <p className="ds-lede" style={{ maxWidth: 520, margin: '0 auto' }}>
          Start free. Upgrade when you outgrow it. No surprise overage charges.
        </p>
      </section>

      <section
        aria-label="Plans"
        style={{
          display: 'grid',
          gridTemplateColumns: 'repeat(auto-fit, minmax(260px, 1fr))',
          gap: 'var(--space-4)',
        }}
      >
        {TIERS.map((tier) => (
          <article
            key={tier.name}
            className="suggestion-card stack-sm"
            style={{
              padding: 'var(--space-5)',
              border: tier.highlight
                ? '2px solid var(--accent)'
                : '1px solid var(--border)',
              borderRadius: 12,
            }}
          >
            <header className="stack-sm" style={{ gap: 'var(--space-1)' }}>
              <div style={{ display: 'flex', alignItems: 'center', gap: 'var(--space-2)' }}>
                <h2 className="ds-h3" style={{ margin: 0 }}>
                  {tier.name}
                </h2>
                {tier.highlight ? (
                  <span
                    className="ds-meta"
                    style={{
                      background: 'color-mix(in oklch, var(--accent), transparent 85%)',
                      color: 'var(--accent)',
                      padding: '2px 8px',
                      borderRadius: 999,
                      fontWeight: 600,
                    }}
                  >
                    Popular
                  </span>
                ) : null}
              </div>
              <div style={{ display: 'flex', alignItems: 'baseline', gap: 'var(--space-2)' }}>
                <span style={{ fontSize: 'var(--text-2xl)', fontWeight: 800 }}>{tier.price}</span>
                <span className="ds-meta">{tier.cadence}</span>
              </div>
              <p className="ds-meta" style={{ margin: 0 }}>
                {tier.tagline}
              </p>
            </header>
            <ul className="stack-sm" style={{ listStyle: 'none', padding: 0, margin: 0 }}>
              {tier.features.map((f) => (
                <li key={f} style={{ display: 'flex', gap: 'var(--space-2)' }}>
                  <span aria-hidden="true" style={{ color: 'var(--accent)', fontWeight: 700 }}>
                    ✓
                  </span>
                  <span>{f}</span>
                </li>
              ))}
            </ul>
            <Link to={tier.cta.to}>
              <button
                type="button"
                className={`btn ${tier.highlight ? 'btn--primary' : 'btn--secondary'}`}
                style={{ width: '100%' }}
              >
                {tier.cta.label}
              </button>
            </Link>
          </article>
        ))}
      </section>

      <section className="stack-sm" aria-label="Compare plans">
        <h2 className="ds-h3" style={{ margin: 0 }}>
          Compare plans
        </h2>
        <div style={{ overflowX: 'auto' }}>
          <table
            style={{
              width: '100%',
              borderCollapse: 'collapse',
              fontSize: 'var(--text-sm)',
            }}
          >
            <thead>
              <tr>
                <th style={{ textAlign: 'left', padding: 'var(--space-2)', borderBottom: '1px solid var(--border)' }}>
                  Feature
                </th>
                <th style={{ textAlign: 'left', padding: 'var(--space-2)', borderBottom: '1px solid var(--border)' }}>
                  Free
                </th>
                <th style={{ textAlign: 'left', padding: 'var(--space-2)', borderBottom: '1px solid var(--border)' }}>
                  Creator
                </th>
              </tr>
            </thead>
            <tbody>
              {COMPARISON.map((row) => (
                <tr key={row.feature}>
                  <td style={{ padding: 'var(--space-2)', borderBottom: '1px solid var(--border)', fontWeight: 600 }}>
                    {row.feature}
                  </td>
                  <td style={{ padding: 'var(--space-2)', borderBottom: '1px solid var(--border)' }}>{row.free}</td>
                  <td style={{ padding: 'var(--space-2)', borderBottom: '1px solid var(--border)' }}>{row.creator}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </section>

      <section className="stack-sm" aria-label="Frequently asked questions">
        <h2 className="ds-h3" style={{ margin: 0 }}>
          Frequently asked
        </h2>
        <div className="stack-sm">
          {FAQ.map((item) => (
            <details
              key={item.q}
              style={{
                border: '1px solid var(--border)',
                borderRadius: 8,
                padding: 'var(--space-3)',
              }}
            >
              <summary style={{ cursor: 'pointer', fontWeight: 600 }}>{item.q}</summary>
              <p style={{ marginTop: 'var(--space-2)', marginBottom: 0 }}>{item.a}</p>
            </details>
          ))}
        </div>
      </section>

      <section
        className="stack-sm"
        style={{ alignItems: 'center', textAlign: 'center', paddingBottom: 'var(--space-6)' }}
      >
        <p className="ds-meta">Still have questions?</p>
        <p>
          Email <a href="mailto:hello@spooool.com">hello@spooool.com</a> — we read everything.
        </p>
      </section>
    </main>
  );
}
