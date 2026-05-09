// ALO-127 — public pricing surface for the E8 launch. Numbers here are
// intentionally hard-coded marketing copy; once Stripe + entitlements ship
// (separate ticket), the membership CTAs should call into a checkout flow
// instead of a mailto: link.

import { Link } from 'react-router-dom';

interface Tier {
  name: string;
  tagline: string;
  price: string;
  cadence: string;
  features: string[];
  cta: { label: string; to: string };
  highlighted?: boolean;
}

const TIERS: Tier[] = [
  {
    name: 'Free',
    tagline: 'For getting started — no card, no commitment.',
    price: '$0',
    cadence: 'forever',
    features: [
      '5 GB of storage',
      'Unlimited public uploads',
      '1080p streaming',
      'Comments, likes, and channels',
      'Basic analytics',
    ],
    cta: { label: 'Create a free account', to: '/signup' },
  },
  {
    name: 'Creator',
    tagline: 'For people who post weekly and want their own corner of the web.',
    price: '$8',
    cadence: 'per month',
    features: [
      '100 GB of storage',
      '4K streaming',
      'Custom channel URL + theme',
      'Per-video tag/category control',
      'Priority encoding queue',
      'Email support',
    ],
    cta: { label: 'Join the waitlist', to: '/waitlist?tier=creator' },
    highlighted: true,
  },
  {
    name: 'Studio',
    tagline: 'For teams and prolific channels with audience growth as a job.',
    price: '$32',
    cadence: 'per month',
    features: [
      '1 TB of storage',
      'Multi-seat channel admin',
      'Stream pre-publish review',
      'Advanced retention analytics',
      'DMCA fast-track',
      'Direct line to support',
    ],
    cta: { label: 'Join the waitlist', to: '/waitlist?tier=studio' },
  },
];

function TierCard({ tier }: { tier: Tier }): JSX.Element {
  return (
    <article
      className={tier.highlighted ? 'card stack' : 'card stack'}
      style={{
        borderColor: tier.highlighted
          ? 'color-mix(in oklch, var(--ring), transparent 40%)'
          : undefined,
        boxShadow: tier.highlighted ? 'var(--shadow-float)' : undefined,
      }}
    >
      <div className="stack-sm">
        <span className="ds-label">{tier.name}</span>
        <h2 className="ds-h2" style={{ margin: 0 }}>
          {tier.price}{' '}
          <span className="ds-meta" style={{ fontWeight: 400 }}>
            {tier.cadence}
          </span>
        </h2>
        <p className="ds-meta">{tier.tagline}</p>
      </div>
      <ul style={{ listStyle: 'none', padding: 0, margin: 0, display: 'grid', gap: 8 }}>
        {tier.features.map((feature) => (
          <li key={feature} style={{ display: 'flex', gap: 8 }}>
            <span aria-hidden="true">✓</span>
            <span>{feature}</span>
          </li>
        ))}
      </ul>
      <Link to={tier.cta.to}>
        <button
          type="button"
          className={tier.highlighted ? 'btn' : 'btn btn--secondary'}
          style={{ width: '100%' }}
        >
          {tier.cta.label}
        </button>
      </Link>
    </article>
  );
}

export function Pricing(): JSX.Element {
  return (
    <main className="app-main stack-lg fade-in">
      <section
        className="stack-sm"
        style={{ alignItems: 'center', textAlign: 'center', paddingTop: 'var(--space-8)' }}
      >
        <span className="ds-label">Pricing</span>
        <h1 className="ds-h1" style={{ margin: 0 }}>
          Simple plans. Honest pricing.
        </h1>
        <p className="ds-lede" style={{ maxWidth: 560, margin: '0 auto' }}>
          spooool is free for everyone. Upgrade only when storage or features call
          for it — never for the basics.
        </p>
      </section>

      <section
        aria-label="Pricing tiers"
        style={{
          display: 'grid',
          gridTemplateColumns: 'repeat(auto-fit, minmax(260px, 1fr))',
          gap: 'var(--space-4)',
        }}
      >
        {TIERS.map((tier) => (
          <TierCard key={tier.name} tier={tier} />
        ))}
      </section>

      <section className="stack-sm">
        <h2 className="ds-h3" style={{ margin: 0 }}>FAQ</h2>
        <details className="card card--tight">
          <summary>What happens if I exceed my storage quota?</summary>
          <p className="ds-meta" style={{ marginTop: 8 }}>
            New uploads are rejected with a clear error until you delete videos
            or upgrade. Existing videos keep playing — we never lock content
            you&apos;ve already published.
          </p>
        </details>
        <details className="card card--tight">
          <summary>Is there a free trial of paid tiers?</summary>
          <p className="ds-meta" style={{ marginTop: 8 }}>
            The Free tier is permanent — there&apos;s no trial. Once paid tiers
            launch, every plan is monthly with no contract; cancel any time.
          </p>
        </details>
        <details className="card card--tight">
          <summary>Do you sell my data?</summary>
          <p className="ds-meta" style={{ marginTop: 8 }}>
            No. See <Link to="/legal/privacy">Privacy Policy</Link>.
          </p>
        </details>
      </section>
    </main>
  );
}
