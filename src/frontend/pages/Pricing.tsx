// ALO-180: marketing pricing page. Two-tier copy (Free vs Creator) with a
// comparison table and FAQ. Numbers are sourced from
// `src/workers/storage-quota.ts` (FREE_TIER_QUOTA_BYTES = 5 GiB) and the
// product roadmap in README.md (memberships are listed under Phase 3, so the
// CTA points to a waitlist mailto rather than a live checkout).

import { Fragment, useState } from 'react';
import { Link } from 'react-router-dom';

const FREE_STORAGE_GIB = 5;
const CREATOR_STORAGE_GIB = 100;
const WAITLIST_MAILTO = 'mailto:hello@spooool.com?subject=Creator%20membership%20waitlist';

type Tier = {
  id: 'free' | 'creator';
  name: string;
  price: string;
  cadence: string;
  tagline: string;
  cta: { label: string; to: string; variant: 'primary' | 'secondary' };
  highlights: string[];
  featured?: boolean;
};

const TIERS: Tier[] = [
  {
    id: 'free',
    name: 'Free',
    price: '$0',
    cadence: 'forever',
    tagline: 'Everything you need to share a few clips with the world.',
    cta: { label: 'Create an account', to: '/signup', variant: 'secondary' },
    highlights: [
      `${FREE_STORAGE_GIB} GB of total storage`,
      'Unlimited public uploads up to 2 GB each',
      'Adaptive HLS playback on every device',
      'Channel page, comments, and view counts',
      'Community support',
    ],
  },
  {
    id: 'creator',
    name: 'Creator',
    price: '$9',
    cadence: 'per month',
    tagline: 'For people who post regularly and want room to grow.',
    cta: { label: 'Join the waitlist', to: WAITLIST_MAILTO, variant: 'primary' },
    highlights: [
      `${CREATOR_STORAGE_GIB} GB of storage (20× the free tier)`,
      'Uploads up to 20 GB per file',
      'Custom thumbnails and channel banner',
      'Priority encoding queue',
      'Channel analytics dashboard',
      'Email support within one business day',
    ],
    featured: true,
  },
];

type Row = {
  label: string;
  free: string;
  creator: string;
};

const COMPARISON: { group: string; rows: Row[] }[] = [
  {
    group: 'Hosting',
    rows: [
      { label: 'Total storage', free: `${FREE_STORAGE_GIB} GB`, creator: `${CREATOR_STORAGE_GIB} GB` },
      { label: 'Max upload size', free: '2 GB / file', creator: '20 GB / file' },
      { label: 'Adaptive HLS playback', free: 'Yes', creator: 'Yes' },
      { label: 'Encoding priority', free: 'Standard', creator: 'Priority queue' },
    ],
  },
  {
    group: 'Channel',
    rows: [
      { label: 'Custom channel URL', free: 'Yes', creator: 'Yes' },
      { label: 'Custom thumbnails', free: 'Auto-generated', creator: 'Upload your own' },
      { label: 'Channel banner', free: '—', creator: 'Yes' },
      { label: 'Pinned video', free: '—', creator: 'Yes' },
    ],
  },
  {
    group: 'Insights',
    rows: [
      { label: 'View counts', free: 'Yes', creator: 'Yes' },
      { label: 'Watch-time analytics', free: '—', creator: 'Yes' },
      { label: 'Audience retention', free: '—', creator: 'Yes' },
    ],
  },
  {
    group: 'Support',
    rows: [
      { label: 'Help center & community', free: 'Yes', creator: 'Yes' },
      { label: 'Email support', free: 'Best effort', creator: '1 business day' },
    ],
  },
];

type Faq = {
  q: string;
  a: JSX.Element;
};

const FAQ: Faq[] = [
  {
    q: 'When does Creator launch?',
    a: (
      <>
        Memberships are on the roadmap and the waitlist link above will email
        you the moment checkout is live. Until then, the Free tier is fully
        usable — no credit card required.
      </>
    ),
  },
  {
    q: 'What happens if I exceed my Free storage?',
    a: (
      <>
        New uploads are blocked with a clear error once you pass{' '}
        {FREE_STORAGE_GIB} GB. Existing videos keep playing. Delete clips you
        no longer need or upgrade to Creator to lift the cap.
      </>
    ),
  },
  {
    q: 'Can I cancel anytime?',
    a: (
      <>
        Yes. Creator is month-to-month — cancel from your account settings and
        you keep paid features until the end of the billing period. After
        that, your channel reverts to the Free tier limits.
      </>
    ),
  },
  {
    q: 'Do you watermark my videos or run ads?',
    a: (
      <>
        No watermarks. No pre-roll ads. No mid-roll ads. spooool is a video
        host, not an attention farm.
      </>
    ),
  },
  {
    q: 'Who owns the content I upload?',
    a: (
      <>
        You do. See the <Link to="/legal/tos">Terms of Service</Link> for the
        license you grant us to host and stream the videos you publish.
      </>
    ),
  },
];

function CheckIcon(): JSX.Element {
  return (
    <span aria-hidden="true" style={{ display: 'inline-block', marginRight: 'var(--space-2)' }}>
      ✓
    </span>
  );
}

function TierCard({ tier }: { tier: Tier }): JSX.Element {
  const isExternal = tier.cta.to.startsWith('mailto:') || tier.cta.to.startsWith('http');
  const ctaClassName = `btn ${tier.cta.variant === 'primary' ? '' : 'btn--secondary'}`.trim();

  return (
    <article
      className="card"
      style={{
        display: 'flex',
        flexDirection: 'column',
        gap: 'var(--space-3)',
        position: 'relative',
        borderColor: tier.featured ? 'var(--primary)' : undefined,
      }}
      aria-labelledby={`tier-${tier.id}-name`}
    >
      {tier.featured ? (
        <span
          className="ds-meta"
          style={{
            position: 'absolute',
            top: -10,
            left: 16,
            background: 'var(--primary)',
            color: 'var(--primary-foreground)',
            padding: '2px 10px',
            borderRadius: 'var(--radius-pill)',
            fontWeight: 700,
            letterSpacing: '0.04em',
            textTransform: 'uppercase',
          }}
        >
          Most popular
        </span>
      ) : null}
      <header className="stack-sm">
        <h2 id={`tier-${tier.id}-name`} className="ds-h2" style={{ margin: 0 }}>
          {tier.name}
        </h2>
        <div style={{ display: 'flex', alignItems: 'baseline', gap: 'var(--space-2)' }}>
          <span style={{ fontSize: 'var(--text-3xl)', fontWeight: 700 }}>{tier.price}</span>
          <span className="ds-meta">{tier.cadence}</span>
        </div>
        <p className="ds-meta" style={{ margin: 0 }}>{tier.tagline}</p>
      </header>
      <ul style={{ listStyle: 'none', padding: 0, margin: 0, display: 'grid', gap: 'var(--space-2)' }}>
        {tier.highlights.map((feature) => (
          <li key={feature}>
            <CheckIcon />
            {feature}
          </li>
        ))}
      </ul>
      {isExternal ? (
        <a
          href={tier.cta.to}
          className={ctaClassName}
          style={{ alignSelf: 'flex-start' }}
        >
          {tier.cta.label}
        </a>
      ) : (
        <Link to={tier.cta.to} className={ctaClassName} style={{ alignSelf: 'flex-start' }}>
          {tier.cta.label}
        </Link>
      )}
    </article>
  );
}

function ComparisonTable(): JSX.Element {
  return (
    <div style={{ overflowX: 'auto' }}>
      <table
        className="pricing-compare"
        style={{
          width: '100%',
          borderCollapse: 'collapse',
          fontSize: 'var(--text-base)',
        }}
      >
        <caption className="ds-meta" style={{ textAlign: 'left', paddingBottom: 'var(--space-2)' }}>
          Feature comparison
        </caption>
        <thead>
          <tr>
            <th
              scope="col"
              style={{
                textAlign: 'left',
                padding: 'var(--space-2) var(--space-3)',
                borderBottom: '1px solid var(--border)',
              }}
            >
              Feature
            </th>
            <th
              scope="col"
              style={{
                textAlign: 'left',
                padding: 'var(--space-2) var(--space-3)',
                borderBottom: '1px solid var(--border)',
              }}
            >
              Free
            </th>
            <th
              scope="col"
              style={{
                textAlign: 'left',
                padding: 'var(--space-2) var(--space-3)',
                borderBottom: '1px solid var(--border)',
              }}
            >
              Creator
            </th>
          </tr>
        </thead>
        <tbody>
          {COMPARISON.map((section) => (
            <Fragment key={section.group}>
              <tr>
                <th
                  scope="rowgroup"
                  colSpan={3}
                  style={{
                    textAlign: 'left',
                    padding: 'var(--space-3) var(--space-3) var(--space-1)',
                    fontSize: 'var(--text-xs)',
                    textTransform: 'uppercase',
                    letterSpacing: '0.06em',
                    color: 'var(--muted-foreground)',
                  }}
                >
                  {section.group}
                </th>
              </tr>
              {section.rows.map((row) => (
                <tr key={`${section.group}-${row.label}`}>
                  <th
                    scope="row"
                    style={{
                      textAlign: 'left',
                      padding: 'var(--space-2) var(--space-3)',
                      borderBottom: '1px solid color-mix(in oklch, var(--border), transparent 50%)',
                      fontWeight: 500,
                    }}
                  >
                    {row.label}
                  </th>
                  <td
                    style={{
                      padding: 'var(--space-2) var(--space-3)',
                      borderBottom: '1px solid color-mix(in oklch, var(--border), transparent 50%)',
                    }}
                  >
                    {row.free}
                  </td>
                  <td
                    style={{
                      padding: 'var(--space-2) var(--space-3)',
                      borderBottom: '1px solid color-mix(in oklch, var(--border), transparent 50%)',
                    }}
                  >
                    {row.creator}
                  </td>
                </tr>
              ))}
            </Fragment>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function FaqItem({ item, defaultOpen }: { item: Faq; defaultOpen: boolean }): JSX.Element {
  const [open, setOpen] = useState(defaultOpen);
  return (
    <details
      open={open}
      onToggle={(e) => setOpen((e.currentTarget as HTMLDetailsElement).open)}
      style={{
        borderBottom: '1px solid var(--border)',
        padding: 'var(--space-3) 0',
      }}
    >
      <summary
        style={{
          cursor: 'pointer',
          fontWeight: 600,
          listStyle: 'none',
          display: 'flex',
          justifyContent: 'space-between',
          alignItems: 'center',
          gap: 'var(--space-3)',
        }}
      >
        <span>{item.q}</span>
        <span aria-hidden="true" style={{ color: 'var(--muted-foreground)' }}>
          {open ? '−' : '+'}
        </span>
      </summary>
      <p style={{ marginTop: 'var(--space-2)', marginBottom: 0 }}>{item.a}</p>
    </details>
  );
}

export function Pricing(): JSX.Element {
  return (
    <main className="app-main stack-lg fade-in">
      <section
        className="stack-sm"
        style={{ alignItems: 'center', textAlign: 'center', paddingTop: 'var(--space-6)' }}
      >
        <h1 className="ds-h1" style={{ margin: 0 }}>Pricing</h1>
        <p className="ds-lede" style={{ maxWidth: 560, margin: '0 auto' }}>
          Free for casual uploaders. A simple monthly plan when you outgrow it.
          No ads, no watermarks, no surprises.
        </p>
      </section>

      <section
        aria-label="Plans"
        style={{
          display: 'grid',
          gap: 'var(--space-4)',
          gridTemplateColumns: 'repeat(auto-fit, minmax(280px, 1fr))',
        }}
      >
        {TIERS.map((tier) => (
          <TierCard key={tier.id} tier={tier} />
        ))}
      </section>

      <section className="stack-sm" aria-labelledby="compare-heading">
        <h2 id="compare-heading" className="ds-h2" style={{ margin: 0 }}>
          Compare plans
        </h2>
        <ComparisonTable />
      </section>

      <section className="stack-sm" aria-labelledby="faq-heading">
        <h2 id="faq-heading" className="ds-h2" style={{ margin: 0 }}>
          Frequently asked
        </h2>
        <div>
          {FAQ.map((item, idx) => (
            <FaqItem key={item.q} item={item} defaultOpen={idx === 0} />
          ))}
        </div>
      </section>

      <section
        className="card"
        style={{
          textAlign: 'center',
          display: 'flex',
          flexDirection: 'column',
          gap: 'var(--space-2)',
          alignItems: 'center',
        }}
      >
        <h2 className="ds-h3" style={{ margin: 0 }}>Still on the fence?</h2>
        <p className="ds-meta" style={{ margin: 0, maxWidth: 480 }}>
          Start free — you can upgrade later without re-uploading anything.
        </p>
        <Link to="/signup">
          <button type="button" className="btn">Create your account</button>
        </Link>
      </section>
    </main>
  );
}
