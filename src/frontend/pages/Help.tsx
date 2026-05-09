// ALO-127 — public help center / creator FAQ. Keeps the marketing surface
// self-contained (no external knowledge base for the launch). Sections are
// grouped so search engines treat them as a single FAQ page.

import { Link } from 'react-router-dom';

interface QA {
  q: string;
  a: JSX.Element;
}

const GETTING_STARTED: QA[] = [
  {
    q: 'How do I upload a video?',
    a: (
      <p>
        Sign in, click <strong>Upload</strong> in the header, and drag in an MP4,
        WebM, MOV, or MKV file. Encoding is automatic — your video is playable
        as soon as the queue catches up (usually under a minute for clips, a
        few minutes for longer files).
      </p>
    ),
  },
  {
    q: 'What file formats and sizes are supported?',
    a: (
      <p>
        We accept MP4, WebM, MOV, and MKV up to your account&apos;s storage
        quota. The Free tier gets 5 GB total — see{' '}
        <Link to="/pricing">Pricing</Link> for upgrade tiers.
      </p>
    ),
  },
  {
    q: 'Why was my upload rejected?',
    a: (
      <p>
        Three common reasons: the file format isn&apos;t in the supported list,
        the file is corrupted, or you&apos;ve hit your storage quota. The error
        message in the upload UI explains which one. Free up space by deleting
        old videos in <Link to="/profile">your profile</Link>.
      </p>
    ),
  },
];

const ACCOUNT: QA[] = [
  {
    q: 'How do I change my email or password?',
    a: (
      <p>
        Visit <Link to="/settings/account">Account settings</Link>. We&apos;ll
        send a verification email to your new address before the change takes
        effect.
      </p>
    ),
  },
  {
    q: 'I forgot my password. What do I do?',
    a: (
      <p>
        Use the <Link to="/forgot-password">password reset</Link> link on the
        sign-in page. The reset link expires after 1 hour for security.
      </p>
    ),
  },
  {
    q: 'How do I delete my account?',
    a: (
      <p>
        Account settings has a <em>Delete account</em> button. Deletion is soft
        for 30 days — you can sign in during that window to cancel — and then
        becomes permanent. All your videos, comments, and contact records are
        purged at the end of the grace period.
      </p>
    ),
  },
];

const POLICIES: QA[] = [
  {
    q: 'What can&apos;t I upload?',
    a: (
      <p>
        Anything you don&apos;t hold the rights to, anything illegal in the
        jurisdiction the content originates from, and anything covered by our{' '}
        <Link to="/legal/tos">Terms of Service</Link>. Repeat infringers lose
        access to the service.
      </p>
    ),
  },
  {
    q: 'Someone uploaded my copyrighted work. How do I get it taken down?',
    a: (
      <p>
        File a DMCA takedown via <Link to="/legal/dmca">our DMCA form</Link>.
        Valid claims are actioned within 72 hours; the uploader has 14 days to
        file a counter-notice before the takedown is finalised.
      </p>
    ),
  },
  {
    q: 'Where do I report harassment, spam, or illegal content?',
    a: (
      <p>
        Every video and comment has a <strong>Report</strong> button. Reports
        are reviewed by our moderation team, which can hide content, ban
        accounts, or escalate to law enforcement when required.
      </p>
    ),
  },
];

function FaqGroup({ title, items }: { title: string; items: QA[] }): JSX.Element {
  return (
    <section className="stack-sm">
      <h2 className="ds-h3" style={{ margin: 0 }}>{title}</h2>
      <div className="stack-sm">
        {items.map((item) => (
          <details key={item.q} className="card card--tight">
            <summary><strong>{item.q}</strong></summary>
            <div className="ds-meta" style={{ marginTop: 8 }}>{item.a}</div>
          </details>
        ))}
      </div>
    </section>
  );
}

export function Help(): JSX.Element {
  return (
    <main className="app-main app-main--narrow stack-lg fade-in">
      <section
        className="stack-sm"
        style={{ alignItems: 'center', textAlign: 'center', paddingTop: 'var(--space-8)' }}
      >
        <span className="ds-label">Help center</span>
        <h1 className="ds-h1" style={{ margin: 0 }}>How can we help?</h1>
        <p className="ds-lede" style={{ maxWidth: 520, margin: '0 auto' }}>
          Common questions about getting your videos online, managing your
          account, and our content policies. Can&apos;t find what you need?{' '}
          <a href="mailto:hello@spooool.com">Email support</a>.
        </p>
      </section>

      <FaqGroup title="Getting started" items={GETTING_STARTED} />
      <FaqGroup title="Account" items={ACCOUNT} />
      <FaqGroup title="Policies & moderation" items={POLICIES} />

      <section className="stack-sm" aria-label="More resources">
        <h2 className="ds-h3" style={{ margin: 0 }}>More</h2>
        <p className="ds-meta">
          <Link to="/status">Service status</Link> ·{' '}
          <Link to="/legal/tos">Terms of Service</Link> ·{' '}
          <Link to="/legal/privacy">Privacy Policy</Link> ·{' '}
          <Link to="/legal/dmca">DMCA</Link>
        </p>
      </section>
    </main>
  );
}
