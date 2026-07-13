import { Link } from 'react-router-dom';

type Section = {
  id: string;
  title: string;
  questions: { q: string; a: string | JSX.Element }[];
};

const SECTIONS: Section[] = [
  {
    id: 'getting-started',
    title: 'Getting started',
    questions: [
      {
        q: 'How do I create an account?',
        a: (
          <>
            Head to <Link to="/signup" className="ds-link">/signup</Link>. You can sign up with an email and
            password or use Google or GitHub. After signing up you'll go through a short onboarding
            flow to pick a username and add a profile photo.
          </>
        ),
      },
      {
        q: 'What is the onboarding flow?',
        a: 'Three quick steps: choose a username, upload an avatar, then upload your first video. Every step is optional — you can skip any of them and come back later from Account Settings.',
      },
      {
        q: 'What can I do on the free plan?',
        a: 'Everything you need to run a channel: upload videos up to your 5 GiB quota, adaptive HLS playback, channel page, subscriptions, comments, likes, tags, search, and watch history.',
      },
    ],
  },
  {
    id: 'uploading',
    title: 'Uploading & storage',
    questions: [
      {
        q: 'What file formats are supported?',
        a: 'MP4, WebM, MOV, and MKV. We transcode every upload to adaptive HLS so viewers get the best quality for their connection.',
      },
      {
        q: 'How large can my files be?',
        a: 'The free plan includes 5 GiB of total storage. The Creator plan gives you 500 GiB. Individual file size is limited by your available quota, not a per-file cap.',
      },
      {
        q: 'How long does transcoding take?',
        a: 'Most videos are ready within a few minutes. Creator-plan accounts get priority in the transcoding queue so they go faster during peak times.',
      },
      {
        q: 'Can I edit or replace a video after uploading?',
        a: 'You can update the title, description, and tags at any time from the video page. To replace the video itself, delete the existing upload and re-upload the new file.',
      },
      {
        q: 'What happens when I hit my storage quota?',
        a: "You'll see a warning in your account. You won't be able to upload new videos until you delete older ones or upgrade to the Creator plan.",
      },
    ],
  },
  {
    id: 'monetization',
    title: 'Creator monetization',
    questions: [
      {
        q: 'How does tipping work?',
        a: 'Viewers on any plan can send a one-off tip to a Creator-tier channel. You receive 90% of each tip; Spooool takes a 10% platform fee (processing fees on top, via Polar/Stripe).',
      },
      {
        q: 'What are memberships?',
        a: 'Creator-tier accounts can offer a recurring membership to their audience. Supporters pay a monthly fee you set; the same 90/10 split applies.',
      },
      {
        q: 'How do I receive payouts?',
        a: 'Payouts are processed through Polar. Connect your Polar account from the Payouts page, set up a payout method (bank transfer or Stripe), and earnings accumulate until the payout threshold is met.',
      },
      {
        q: 'Is there a minimum payout amount?',
        a: 'Polar's minimum payout threshold applies — check your Polar dashboard for the current amount.',
      },
    ],
  },
  {
    id: 'privacy-safety',
    title: 'Privacy & safety',
    questions: [
      {
        q: 'How do I report a video or comment?',
        a: 'Every video and comment has a "Report" option. Pick a reason, submit it, and our moderation team reviews it. We aim to action reports within 48 hours.',
      },
      {
        q: 'How does the DMCA process work?',
        a: (
          <>
            If you believe content on Spooool infringes your copyright, file a takedown notice via{' '}
            <Link to="/legal/dmca" className="ds-link">the DMCA form</Link>. The uploader will be
            notified and given the opportunity to file a counter-notice. See our{' '}
            <Link to="/legal/tos" className="ds-link">Terms of Service</Link> for the full policy.
          </>
        ),
      },
      {
        q: 'How do I delete my account?',
        a: 'Go to Account Settings → scroll to the bottom → "Request account deletion". Your account enters a 30-day grace period. You can cancel by signing back in. After 30 days, your videos, profile, and credentials are permanently deleted.',
      },
      {
        q: 'What data do you collect?',
        a: (
          <>
            See the <Link to="/legal/privacy" className="ds-link">Privacy Policy</Link> for the full
            breakdown. The short version: we collect your email for authentication, usage analytics
            to improve the product (opt-out supported via Do Not Track), and video metadata you
            provide. We don't run ads and never sell your data.
          </>
        ),
      },
    ],
  },
  {
    id: 'account',
    title: 'Account & billing',
    questions: [
      {
        q: 'How do I upgrade to Creator?',
        a: (
          <>
            Head to the <Link to="/pricing" className="ds-link">Pricing page</Link> and click "Join
            the waitlist" or "Sign up". Once billing is available in your account, you can subscribe
            from Account Settings.
          </>
        ),
      },
      {
        q: 'What happens if I cancel Creator?',
        a: 'Your account drops to the Free tier at the end of the billing period. Uploads stay online as long as your total storage is within the 5 GiB free limit. Uploads over the limit are marked private until you trim or re-upgrade.',
      },
      {
        q: 'I forgot my password. How do I reset it?',
        a: (
          <>
            Go to <Link to="/forgot-password" className="ds-link">Forgot password</Link>, enter your
            email, and we'll send a reset link valid for one hour.
          </>
        ),
      },
      {
        q: 'How do I change my username or avatar?',
        a: 'Visit Account Settings from the user menu in the top-right corner. Usernames must be lowercase letters, numbers, _ or -, 2–30 characters.',
      },
    ],
  },
  {
    id: 'contact',
    title: 'Still need help?',
    questions: [
      {
        q: 'How do I contact support?',
        a: (
          <>
            Email us at{' '}
            <a href="mailto:support@spooool.com" className="ds-link">
              support@spooool.com
            </a>
            . For DMCA matters use{' '}
            <a href="mailto:dmca@spooool.com" className="ds-link">
              dmca@spooool.com
            </a>
            , and for privacy requests{' '}
            <a href="mailto:privacy@spooool.com" className="ds-link">
              privacy@spooool.com
            </a>
            .
          </>
        ),
      },
    ],
  },
];

export function Help(): JSX.Element {
  return (
    <main className="app-main app-main--narrow stack-lg fade-in" style={{ paddingBottom: 'var(--space-10)' }}>
      <section className="stack-sm" style={{ paddingTop: 'var(--space-6)', textAlign: 'center' }}>
        <span className="ds-label">Help center</span>
        <h1 className="ds-h2">How can we help?</h1>
        <p className="ds-lede" style={{ maxWidth: 520, margin: '0 auto' }}>
          Answers to common questions about uploading, monetization, privacy, and your account.
        </p>
      </section>

      <nav aria-label="Help sections" style={{ display: 'flex', flexWrap: 'wrap', gap: 'var(--space-2)' }}>
        {SECTIONS.map((s) => (
          <a key={s.id} href={`#${s.id}`} className="btn btn--ghost btn--sm">
            {s.title}
          </a>
        ))}
      </nav>

      {SECTIONS.map((section) => (
        <section key={section.id} id={section.id} className="stack-sm">
          <h2 className="ds-h3" style={{ margin: 0 }}>
            {section.title}
          </h2>
          <div className="stack-sm">
            {section.questions.map((item) => (
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
                <p style={{ marginTop: 'var(--space-3)', marginBottom: 0 }}>{item.a}</p>
              </details>
            ))}
          </div>
        </section>
      ))}
    </main>
  );
}
