import { useState } from 'react';
import { Link } from 'react-router-dom';

type FaqItem = { q: string; a: string | JSX.Element };
type Section = { title: string; items: FaqItem[] };

const SECTIONS: Section[] = [
  {
    title: 'Getting started',
    items: [
      {
        q: 'How do I create an account?',
        a: (
          <>
            Go to{' '}
            <Link to="/signup" className="ds-link">
              spooool.com/signup
            </Link>{' '}
            and enter your name, email, and a password (8+ characters). You can also sign in with
            Google or GitHub. After signing up you'll be asked to pick a username and upload a
            profile photo — skip any step you like.
          </>
        ),
      },
      {
        q: 'Do I need to verify my email?',
        a: 'Yes. We send a verification link when you sign up. Uploading videos requires a verified email — check your spam folder if the email doesn't arrive within a minute.',
      },
      {
        q: 'What is the Creator tier?',
        a: (
          <>
            The Creator tier ($6/month) adds 500 GiB of storage, per-video tipping, recurring
            memberships, a custom channel banner, and detailed analytics on top of everything in
            the Free tier. Creator spots are currently invite-only.{' '}
            <Link to="/waitlist" className="ds-link">
              Join the waitlist
            </Link>
            .
          </>
        ),
      },
    ],
  },
  {
    title: 'Uploading videos',
    items: [
      {
        q: 'What file formats are supported?',
        a: 'MP4, WebM, MOV, and MKV. We transcode everything to adaptive-bitrate HLS on Cloudflare Stream, so playback works across all devices and connection speeds.',
      },
      {
        q: 'What is the file size limit?',
        a: 'There is no per-file size cap. However Free accounts have a 5 GiB total storage limit. If you need more space, upgrade to the Creator tier or delete older uploads.',
      },
      {
        q: 'How long does transcoding take?',
        a: 'Most videos are ready within 1–3 minutes. Creator-tier accounts get priority queue access during high traffic periods. You can close the tab after uploading — transcoding happens in the background.',
      },
      {
        q: 'Can I set a custom thumbnail?',
        a: 'When uploading you can pick a frame from the video to use as the thumbnail. Custom image uploads (JPG/PNG) for thumbnails are on the roadmap.',
      },
      {
        q: 'Can I add tags to my video?',
        a: 'Yes. Add comma-separated tags during upload. Tags make your video discoverable from the Tags page and in search.',
      },
    ],
  },
  {
    title: 'Channels and audience',
    items: [
      {
        q: 'How do I set up my channel?',
        a: (
          <>
            Your channel is created automatically at{' '}
            <span className="ds-meta">spooool.com/channel/your-username</span> as soon as you
            set a username in onboarding or{' '}
            <Link to="/settings/account" className="ds-link">
              Account Settings
            </Link>
            . Creator-tier accounts can also add a bio and custom banner image.
          </>
        ),
      },
      {
        q: 'How do viewers subscribe to my channel?',
        a: 'Signed-in viewers can click "Subscribe" on your channel page. Subscribers get new-upload notifications in their notification bell.',
      },
      {
        q: 'Can people comment on my videos?',
        a: 'Yes. Comments are threaded and open to all signed-in users. You can report comments for moderation. Our spam filter catches most junk automatically.',
      },
    ],
  },
  {
    title: 'Monetization',
    items: [
      {
        q: 'How does tipping work?',
        a: 'Creator-tier accounts can enable one-time tips on any video. Viewers click "Tip this creator", pick an amount, and pay via Stripe. You receive 90% of the tip (minus Stripe/Polar processing fees). Spooool keeps 10%.',
      },
      {
        q: 'How do recurring memberships work?',
        a: 'Creator-tier accounts can set up monthly or yearly membership tiers in their Polar dashboard, then link them to their channel from Account Settings. Subscribers pay monthly/yearly and access any member-gated content you post.',
      },
      {
        q: 'How do I get paid?',
        a: (
          <>
            Payouts are handled through{' '}
            <span className="ds-meta">Polar</span>. Connect your Polar account from{' '}
            <Link to="/settings/account" className="ds-link">
              Account Settings
            </Link>
            , then Polar routes your earnings to your bank or Stripe account. You can see your
            pending and paid balance on the{' '}
            <Link to="/payouts" className="ds-link">
              Payouts page
            </Link>
            .
          </>
        ),
      },
      {
        q: 'When do payouts happen?',
        a: 'Polar processes payouts on a rolling schedule. Most payouts land within 3–5 business days of the tip or membership charge being settled. Check your Polar dashboard for exact timing.',
      },
    ],
  },
  {
    title: 'Account and settings',
    items: [
      {
        q: 'How do I change my username?',
        a: (
          <>
            Go to{' '}
            <Link to="/settings/account" className="ds-link">
              Account Settings
            </Link>{' '}
            and update the username field. Changing your username updates your channel URL — any
            existing links to the old URL will break.
          </>
        ),
      },
      {
        q: 'How do I delete my account?',
        a: (
          <>
            In{' '}
            <Link to="/settings/account" className="ds-link">
              Account Settings
            </Link>{' '}
            scroll to the bottom and click "Request account deletion". Your account and all your
            videos will be permanently removed 30 days later. You can cancel the deletion by
            signing back in within that window.
          </>
        ),
      },
      {
        q: 'How do I manage notification emails?',
        a: (
          <>
            Toggle per-event email notifications in{' '}
            <Link to="/settings/account" className="ds-link">
              Account Settings
            </Link>{' '}
            — new subscriber, new comment, new tip, and upload digest.
          </>
        ),
      },
    ],
  },
  {
    title: 'Privacy and data',
    items: [
      {
        q: 'What data do you collect?',
        a: (
          <>
            We collect account information (email, name), content you upload, and usage data to
            improve the product. We use PostHog for analytics (opt-in, with your consent) and
            Sentry for error monitoring. See the full{' '}
            <Link to="/legal/privacy" className="ds-link">
              Privacy Policy
            </Link>
            .
          </>
        ),
      },
      {
        q: 'Can I opt out of analytics?',
        a: 'Yes. Click "Cookie preferences" in the bottom-right corner of any page and choose Decline. We honour Do Not Track (DNT) browser signals automatically.',
      },
      {
        q: 'How do I request a copy of my data?',
        a: 'Email privacy@spooool.com from the address on your account and we will send you a data export within 30 days (as required by GDPR Article 15).',
      },
    ],
  },
  {
    title: 'Content policies',
    items: [
      {
        q: 'What content is prohibited?',
        a: (
          <>
            We have zero tolerance for child sexual abuse material (CSAM), content that
            facilitates real-world violence, and spam. See the full list in our{' '}
            <Link to="/legal/tos" className="ds-link">
              Terms of Service
            </Link>
            .
          </>
        ),
      },
      {
        q: 'How do I report a video or comment?',
        a: 'Use the Report button on any video or comment. Our moderation team reviews reports within 24–48 hours. Serious violations (CSAM, credible threats) are escalated immediately.',
      },
      {
        q: 'How do I file a DMCA takedown?',
        a: (
          <>
            Submit a formal notice at{' '}
            <Link to="/legal/dmca" className="ds-link">
              spooool.com/legal/dmca
            </Link>
            . The uploader will be notified and can file a counter-notice. See our{' '}
            <Link to="/legal/tos" className="ds-link">
              Terms of Service
            </Link>{' '}
            for the full DMCA policy.
          </>
        ),
      },
    ],
  },
];

function FaqEntry({ item }: { item: FaqItem }): JSX.Element {
  const [open, setOpen] = useState(false);
  return (
    <details
      className="card"
      style={{ padding: 'var(--space-3) var(--space-4)' }}
      open={open}
      onToggle={(e) => setOpen((e.target as HTMLDetailsElement).open)}
    >
      <summary
        style={{
          cursor: 'pointer',
          fontWeight: 600,
          fontSize: 'var(--text-base)',
          listStyle: 'none',
          display: 'flex',
          justifyContent: 'space-between',
          alignItems: 'center',
          gap: 'var(--space-3)',
        }}
      >
        <span>{item.q}</span>
        <span
          aria-hidden="true"
          style={{
            flexShrink: 0,
            fontSize: 'var(--text-sm)',
            transition: 'transform 200ms',
            transform: open ? 'rotate(45deg)' : 'none',
            color: 'var(--foreground-muted)',
          }}
        >
          +
        </span>
      </summary>
      <div
        className="ds-meta"
        style={{ marginTop: 'var(--space-3)', lineHeight: 1.6 }}
      >
        {typeof item.a === 'string' ? <p style={{ margin: 0 }}>{item.a}</p> : item.a}
      </div>
    </details>
  );
}

export function Help(): JSX.Element {
  return (
    <main className="app-main app-main--narrow stack-lg fade-in" style={{ paddingBottom: 'var(--space-12)' }}>
      <section className="stack-sm" style={{ paddingTop: 'var(--space-6)', textAlign: 'center' }}>
        <span className="ds-label">Help center</span>
        <h1 className="ds-h2">Creator help center</h1>
        <p className="ds-lede" style={{ maxWidth: 540, margin: '0 auto' }}>
          Everything you need to get started, upload videos, and earn from your audience.
        </p>
      </section>

      {SECTIONS.map((section) => (
        <section key={section.title} className="stack-sm">
          <h2 className="ds-h3" style={{ margin: 0 }}>
            {section.title}
          </h2>
          <div className="stack-sm">
            {section.items.map((item) => (
              <FaqEntry key={item.q} item={item} />
            ))}
          </div>
        </section>
      ))}

      <section
        className="card stack-sm"
        style={{ textAlign: 'center', padding: 'var(--space-6)' }}
      >
        <h2 className="ds-h3" style={{ margin: 0 }}>
          Still have questions?
        </h2>
        <p className="ds-meta" style={{ margin: 0 }}>
          Email us at{' '}
          <a href="mailto:hello@spooool.com" className="ds-link">
            hello@spooool.com
          </a>{' '}
          and we'll get back to you within one business day.
        </p>
      </section>
    </main>
  );
}
