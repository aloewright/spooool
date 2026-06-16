import { Link } from 'react-router-dom';

import type { JSX } from "react";

type Tier = {
  id: 'free' | 'creator';
  name: string;
  blurb: string;
  price: string;
  cadence: string;
  cta: { label: string; to: string };
  emphasis?: boolean;
  features: string[];
};

// Pricing source of truth lives here so the comparison table and the
// feature list below stay in sync. Numbers reflect the free tier limits
// already enforced by the upload path (5 GiB quota, ALO-139) and the
// roadmap targets for the paid tier — change here, not in two places.
const TIERS: Tier[] = [
  {
    id: 'free',
    name: 'Free',
    blurb: 'Everything you need to start a channel.',
    price: '$0',
    cadence: 'forever',
    cta: { label: 'Sign up', to: '/signup' },
    features: [
      '5 GiB of total storage',
      'Adaptive bitrate streaming (HLS)',
      'Comments, likes, subscriptions',
      'Channel page + tags',
      'Watch history + resume',
      'Email-verified uploads',
    ],
  },
  {
    id: 'creator',
    name: 'Creator',
    blurb: 'For makers who want headroom and direct support from viewers.',
    price: '$6',
    cadence: 'per month',
    cta: { label: 'Join the waitlist', to: '/signup' },
    emphasis: true,
    features: [
      '500 GiB of total storage',
      'Per-video tipping (90% to you)',
      'Recurring memberships',
      'Custom channel banner + bio',
      'Priority transcoding queue',
      'Detailed view-time analytics',
    ],
  },
];

type FaqEntry = { q: string; a: string };

const FAQ: FaqEntry[] = [
  {
    q: 'Is there a free plan?',
    a: 'Yes. The Free tier is the whole product — playback, comments, channels, subscriptions — with a 5 GiB storage limit. You can upgrade later without losing any uploads.',
  },
  {
    q: 'How does monetization work?',
    a: 'Creator-tier accounts can enable tipping and memberships. Payouts run through Polar. We take a 10% platform fee on tips and memberships; you keep the remaining 90% (minus Polar/Stripe processing).',
  },
  {
    q: 'What happens if I cancel?',
    a: 'Your account drops back to the Free tier at the end of the billing period. Uploads stay online as long as you are inside the free 5 GiB limit. Over the limit, the oldest uploads get marked private until you trim or upgrade.',
  },
  {
    q: 'Do you offer a student or non-profit discount?',
    a: 'Not yet — email support@spooool.com if that matters to you and we will figure something out.',
  },
];

function TierCard({ tier }: { tier: Tier }): JSX.Element {
  return (
    <article
      className="card stack"
      style={{
        borderColor: tier.emphasis
          ? 'color-mix(in oklch, var(--accent-blue), transparent 50%)'
          : undefined,
        boxShadow: tier.emphasis ? 'var(--shadow-float)' : 'var(--shadow-card)',
      }}
    >
      <div className="stack-sm">
        <span className="ds-label">{tier.name}</span>
        <h2 className="ds-h2">{tier.name} tier</h2>
        <p className="ds-meta">{tier.blurb}</p>
      </div>
      <div className="stack-sm">
        <div style={{ fontSize: 'var(--text-3xl)', fontWeight: 700, lineHeight: 1 }}>
          {tier.price}
          <span className="ds-meta" style={{ marginLeft: 'var(--space-2)' }}>
            {tier.cadence}
          </span>
        </div>
      </div>
      <ul className="stack-sm" style={{ listStyle: 'none', padding: 0, margin: 0 }}>
        {tier.features.map((f) => (
          <li key={f} className="row" style={{ gap: 'var(--space-2)' }}>
            <span aria-hidden="true" style={{ color: 'var(--accent-blue)' }}>
              ✓
            </span>
            <span>{f}</span>
          </li>
        ))}
      </ul>
      <Link to={tier.cta.to} className={tier.emphasis ? 'btn' : 'btn btn--secondary'}>
        {tier.cta.label}
      </Link>
    </article>
  );
}

function ComparisonRow({
  label,
  free,
  creator,
}: {
  label: string;
  free: string;
  creator: string;
}): JSX.Element {
  return (
    <tr>
      <th
        scope="row"
        style={{
          textAlign: 'left',
          padding: 'var(--space-2) var(--space-3)',
          fontWeight: 600,
        }}
      >
        {label}
      </th>
      <td style={{ padding: 'var(--space-2) var(--space-3)' }}>{free}</td>
      <td style={{ padding: 'var(--space-2) var(--space-3)' }}>{creator}</td>
    </tr>
  );
}

export function Pricing(): JSX.Element {
  return (
    <main className="app-main stack-lg fade-in">
      <section
        className="stack-sm"
        style={{ textAlign: 'center', paddingTop: 'var(--space-6)' }}
      >
        <span className="ds-label">Pricing</span>
        <h1 className="ds-h2">Simple, creator-friendly pricing</h1>
        <p className="ds-lede" style={{ maxWidth: 560, margin: '0 auto' }}>
          Start free, upgrade when storage or monetization matters. No ads, ever.
        </p>
      </section>

      <section
        aria-label="Plan tiers"
        style={{
          display: 'grid',
          gridTemplateColumns: 'repeat(auto-fit, minmax(280px, 1fr))',
          gap: 'var(--space-4)',
        }}
      >
        {TIERS.map((tier) => (
          <TierCard key={tier.id} tier={tier} />
        ))}
      </section>

      <section aria-label="Feature comparison" className="stack-sm">
        <h2 className="ds-h3" style={{ margin: 0 }}>Compare plans</h2>
        <div className="card" style={{ padding: 0, overflowX: 'auto' }}>
          <table
            style={{
              width: '100%',
              borderCollapse: 'collapse',
              fontSize: 'var(--text-base)',
            }}
          >
            <thead>
              <tr>
                <th style={{ textAlign: 'left', padding: 'var(--space-3)' }}>Feature</th>
                <th style={{ textAlign: 'left', padding: 'var(--space-3)' }}>Free</th>
                <th style={{ textAlign: 'left', padding: 'var(--space-3)' }}>Creator</th>
              </tr>
            </thead>
            <tbody>
              <ComparisonRow label="Storage" free="5 GiB" creator="500 GiB" />
              <ComparisonRow label="Adaptive bitrate (HLS)" free="✓" creator="✓" />
              <ComparisonRow label="Subscriptions" free="✓" creator="✓" />
              <ComparisonRow label="Comments + likes" free="✓" creator="✓" />
              <ComparisonRow label="Tipping" free="—" creator="✓" />
              <ComparisonRow label="Memberships" free="—" creator="✓" />
              <ComparisonRow label="Priority transcoding" free="—" creator="✓" />
              <ComparisonRow label="View-time analytics" free="Basic" creator="Detailed" />
              <ComparisonRow label="Platform fee" free="0%" creator="10% of payouts" />
            </tbody>
          </table>
        </div>
      </section>

      <section aria-label="FAQ" className="stack-sm">
        <h2 className="ds-h3" style={{ margin: 0 }}>Frequently asked</h2>
        <div className="stack">
          {FAQ.map((item) => (
            <details key={item.q} className="card">
              <summary
                style={{
                  cursor: 'pointer',
                  fontWeight: 600,
                  fontSize: 'var(--text-base)',
                }}
              >
                {item.q}
              </summary>
              <p style={{ marginTop: 'var(--space-3)' }}>{item.a}</p>
            </details>
          ))}
        </div>
      </section>
    </main>
  );
}
