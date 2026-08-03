import { Link } from 'react-router-dom';

const FACTS: { label: string; value: string }[] = [
  { label: 'Founded', value: '2026' },
  { label: 'Headquarters', value: 'Portland, OR' },
  { label: 'Platform', value: 'spooool.com' },
  { label: 'Press contact', value: 'press@spooool.com' },
];

export function Press(): JSX.Element {
  return (
    <main
      className="app-main app-main--narrow stack-lg fade-in"
      style={{ paddingBottom: 'var(--space-12)' }}
    >
      <section className="stack-sm" style={{ paddingTop: 'var(--space-6)', textAlign: 'center' }}>
        <span className="ds-label">Press</span>
        <h1 className="ds-h2">About Spooool</h1>
        <p className="ds-lede" style={{ maxWidth: 560, margin: '0 auto' }}>
          Creator-first video hosting — adaptive streaming, channel pages, memberships, and
          tipping. No ads. No algorithm fighting you.
        </p>
      </section>

      {/* Boilerplate */}
      <section className="card stack">
        <h2 className="ds-h3" style={{ margin: 0 }}>
          About
        </h2>
        <p>
          Spooool is a video hosting platform built for independent creators. It offers
          adaptive-bitrate HLS streaming, channel pages, full-text search, and a direct
          monetization layer (one-time tips and recurring memberships powered by Polar and
          Stripe) — all with no advertising and no opaque ranking algorithm.
        </p>
        <p>
          The platform runs entirely on Cloudflare's edge infrastructure: Workers for
          compute, Stream for transcoding, R2 for storage (zero egress fees), and D1 for
          the database. A free tier (5 GiB storage) is available to anyone; the Creator
          tier ($6/month, 500 GiB) is currently invite-only.
        </p>
      </section>

      {/* Fast facts */}
      <section className="stack-sm">
        <h2 className="ds-h3" style={{ margin: 0 }}>
          Fast facts
        </h2>
        <div
          style={{
            border: '1px solid var(--border)',
            borderRadius: 'var(--radius-lg)',
            overflow: 'hidden',
          }}
        >
          {FACTS.map((f, i) => (
            <div
              key={f.label}
              style={{
                display: 'flex',
                justifyContent: 'space-between',
                gap: 'var(--space-4)',
                padding: 'var(--space-3) var(--space-4)',
                borderTop: i > 0 ? '1px solid var(--border)' : undefined,
              }}
            >
              <span className="ds-meta">{f.label}</span>
              <span style={{ fontWeight: 600 }}>{f.value}</span>
            </div>
          ))}
        </div>
      </section>

      {/* Key features */}
      <section className="stack-sm">
        <h2 className="ds-h3" style={{ margin: 0 }}>
          Key features
        </h2>
        <ul
          className="stack-sm ds-meta"
          style={{ margin: 0, paddingLeft: 'var(--space-5)', lineHeight: 1.7 }}
        >
          <li>Adaptive-bitrate HLS playback via Cloudflare Stream</li>
          <li>5 GiB free storage per account; 500 GiB for Creator tier</li>
          <li>Comments with nested replies, likes, and spam filtering</li>
          <li>Channel subscriptions with new-upload email notifications</li>
          <li>Full-text video search (SQLite FTS5)</li>
          <li>One-time tips and monthly/yearly memberships (via Polar + Stripe)</li>
          <li>90% creator revenue share on tips and memberships</li>
          <li>DMCA takedown + counter-notice handling</li>
          <li>AI Studio: screen recording, text-to-video generation, animation tools</li>
          <li>Consent-gated analytics (PostHog) with Do Not Track support</li>
          <li>GDPR/CCPA compliant data practices</li>
        </ul>
      </section>

      {/* Press contact */}
      <section
        className="card stack-sm"
        style={{ textAlign: 'center', padding: 'var(--space-6)' }}
      >
        <h2 className="ds-h3" style={{ margin: 0 }}>
          Press contact
        </h2>
        <p className="ds-meta" style={{ margin: 0 }}>
          For interviews, assets, or embargoed briefings email{' '}
          <a href="mailto:press@spooool.com" className="ds-link">
            press@spooool.com
          </a>
          .
        </p>
        <p className="ds-meta" style={{ margin: 0 }}>
          For legal matters:{' '}
          <a href="mailto:hello@spooool.com" className="ds-link">
            hello@spooool.com
          </a>
          . See our{' '}
          <Link to="/legal/tos" className="ds-link">
            Terms of Service
          </Link>{' '}
          and{' '}
          <Link to="/legal/privacy" className="ds-link">
            Privacy Policy
          </Link>
          .
        </p>
      </section>
    </main>
  );
}
