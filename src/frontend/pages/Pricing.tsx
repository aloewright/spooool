// ALO-127: pricing page. Free tier vs membership, billed via Stripe.
// Copy is pre-launch; numbers reflect the public-launch plan but are still
// subject to change before the first paid signup goes live.

import { Link } from 'react-router-dom';

interface Tier {
  name: string;
  price: string;
  cadence: string;
  tagline: string;
  cta: { label: string; to: string };
  features: string[];
  highlight?: boolean;
}

const TIERS: Tier[] = [
  {
    name: 'Free',
    price: '$0',
    cadence: 'forever',
    tagline: 'Everything you need to start sharing.',
    cta: { label: 'Create an account', to: '/signup' },
    features: [
      '5 GB of storage',
      'Unlimited views',
      'HLS streaming + adaptive bitrate',
      'Public channel page',
      'Comments, likes, watch history',
    ],
  },
  {
    name: 'Member',
    price: '$6',
    cadence: 'per month',
    tagline: 'For creators who want more room and the small touches.',
    cta: { label: 'Join the waitlist', to: '/about#waitlist' },
    features: [
      '100 GB of storage',
      '4K source preservation',
      'Custom channel art + bio',
      'Priority encoding',
      'Email support',
    ],
    highlight: true,
  },
  {
    name: 'Studio',
    price: '$24',
    cadence: 'per month',
    tagline: 'Bigger libraries, team access, and DMCA help.',
    cta: { label: 'Talk to us', to: 'mailto:hello@spooool.com' },
    features: [
      '1 TB of storage',
      'Up to 5 collaborators per channel',
      'Bulk upload + scheduling',
      'DMCA assistance',
      'Priority email support',
    ],
  },
];

export function Pricing(): JSX.Element {
  return (
    <main className="app-main app-main--narrow stack-lg fade-in">
      <section className="stack-sm" style={{ textAlign: 'center', paddingTop: 'var(--space-6)' }}>
        <h1 className="ds-h1" style={{ margin: 0 }}>Simple pricing.</h1>
        <p className="ds-lede" style={{ maxWidth: 520, margin: '0 auto' }}>
          Free for everyone. Pay when you outgrow it — no ads, ever.
        </p>
      </section>

      <section
        aria-label="Plans"
        style={{
          display: 'grid',
          gridTemplateColumns: 'repeat(auto-fit, minmax(260px, 1fr))',
          gap: 'var(--space-3)',
        }}
      >
        {TIERS.map((tier) => (
          <article
            key={tier.name}
            className="suggestion-card stack-sm"
            style={{
              borderColor: tier.highlight ? 'var(--accent)' : undefined,
              boxShadow: tier.highlight ? '0 0 0 1px var(--accent)' : undefined,
            }}
          >
            <header className="stack-sm">
              <div style={{ fontWeight: 700, fontSize: 'var(--text-lg)' }}>{tier.name}</div>
              <div>
                <span style={{ fontSize: 'var(--text-xl)', fontWeight: 800 }}>{tier.price}</span>{' '}
                <span className="ds-meta">{tier.cadence}</span>
              </div>
              <p className="ds-meta" style={{ margin: 0 }}>
                {tier.tagline}
              </p>
            </header>
            <ul style={{ listStyle: 'none', padding: 0, margin: 0 }} className="stack-sm">
              {tier.features.map((feature) => (
                <li key={feature} className="ds-meta">
                  · {feature}
                </li>
              ))}
            </ul>
            {tier.cta.to.startsWith('mailto:') ? (
              <a href={tier.cta.to} className="btn btn--secondary btn--sm">
                {tier.cta.label}
              </a>
            ) : (
              <Link to={tier.cta.to} className="btn btn--secondary btn--sm">
                {tier.cta.label}
              </Link>
            )}
          </article>
        ))}
      </section>

      <section className="stack-sm" aria-label="FAQ">
        <h2 className="ds-h3" style={{ margin: 0 }}>Common questions</h2>
        <details>
          <summary>Can I switch plans later?</summary>
          <p className="ds-meta">
            Yes. Upgrade or downgrade any time from{' '}
            <Link to="/settings/account">Account settings</Link>. Storage above your new
            plan&apos;s limit stays accessible but uploads pause until you&apos;re back under.
          </p>
        </details>
        <details>
          <summary>Are there any ads or trackers?</summary>
          <p className="ds-meta">
            No ads. We use first-party analytics (PostHog) for product metrics — no third-party
            ad networks. See our <Link to="/legal/privacy">Privacy Policy</Link>.
          </p>
        </details>
        <details>
          <summary>What happens if I exceed my storage?</summary>
          <p className="ds-meta">
            New uploads return a 413 with code <code>storage_quota_exceeded</code>. Existing
            videos keep streaming.
          </p>
        </details>
      </section>
    </main>
  );
}
