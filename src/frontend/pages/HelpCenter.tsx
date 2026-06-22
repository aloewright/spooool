import { Link, useParams, Navigate } from 'react-router-dom';

type Article = {
  id: string;
  title: string;
  body: JSX.Element;
};

type Category = {
  id: string;
  title: string;
  articles: Article[];
};

const CATEGORIES: Category[] = [
  {
    id: 'getting-started',
    title: 'Getting started',
    articles: [
      {
        id: 'what-is-spooool',
        title: 'What is spooool?',
        body: (
          <div className="stack-sm">
            <p>
              spooool is a creator-first video hosting platform built on Cloudflare's global
              network. You upload your videos, we stream them anywhere in the world — no ads, no
              algorithm fighting you for reach.
            </p>
            <p>
              The Free tier gives you 5 GiB of storage, adaptive bitrate streaming, a channel page,
              comments, likes, subscriptions, and watch history — the whole product, with no
              expiration.
            </p>
            <p>
              The Creator tier ($6/month) unlocks 500 GiB of storage, per-video tipping, recurring
              memberships, and detailed analytics.
            </p>
          </div>
        ),
      },
      {
        id: 'create-account',
        title: 'Creating your account',
        body: (
          <div className="stack-sm">
            <p>
              Head to <Link to="/signup" className="ds-link">/signup</Link> and enter your email
              and a password. You can also sign in with Google or GitHub.
            </p>
            <p>
              After signing up you'll go through a short onboarding flow: pick a username, upload a
              profile photo, and optionally drop in your first video. You can skip any step and
              come back later from your profile settings.
            </p>
            <p>
              Your username becomes your channel URL —{' '}
              <code style={{ fontSize: '0.9em' }}>spooool.com/channel/yourname</code> — so pick
              something you're happy with. You can change it once from{' '}
              <Link to="/settings/account" className="ds-link">Account settings</Link>.
            </p>
          </div>
        ),
      },
      {
        id: 'first-upload',
        title: 'Your first upload',
        body: (
          <div className="stack-sm">
            <p>
              Go to <Link to="/upload" className="ds-link">Upload</Link> (the arrow icon in the top
              nav). Drag in an MP4, WebM, MOV, or MKV file — up to your plan's storage quota.
            </p>
            <p>
              Fill in a title, optional description, and tags. Tags make your video discoverable in
              search and on tag browse pages. Once you click <strong>Publish</strong>, the video
              goes into our transcoding queue and will be ready to stream within a few minutes.
            </p>
            <p>
              While it processes you'll see a "Processing…" badge on the watch page. Refresh after
              a minute or two and playback will be live.
            </p>
          </div>
        ),
      },
    ],
  },
  {
    id: 'channel',
    title: 'Channel & profile',
    articles: [
      {
        id: 'channel-setup',
        title: 'Setting up your channel',
        body: (
          <div className="stack-sm">
            <p>
              Your channel lives at{' '}
              <code style={{ fontSize: '0.9em' }}>spooool.com/channel/yourusername</code>. It shows
              your avatar, bio, banner (Creator tier), and all your public videos.
            </p>
            <p>
              Edit your profile at <Link to="/profile" className="ds-link">Profile settings</Link>.
              You can set a display name, bio, and avatar. Creator-tier accounts can also upload a
              channel banner image.
            </p>
          </div>
        ),
      },
      {
        id: 'subscriptions',
        title: 'Subscriptions & notifications',
        body: (
          <div className="stack-sm">
            <p>
              Viewers can subscribe to your channel with one click. When they do, new uploads
              appear in their subscription feed and they can opt in to email notifications.
            </p>
            <p>
              You can see your subscriber count on your channel page. Paid subscribers (people
              supporting you with a membership) are listed under{' '}
              <Link to="/subscriptions" className="ds-link">Subscriptions</Link> in your account.
            </p>
          </div>
        ),
      },
    ],
  },
  {
    id: 'video',
    title: 'Video management',
    articles: [
      {
        id: 'formats',
        title: 'Supported formats & limits',
        body: (
          <div className="stack-sm">
            <p>
              spooool accepts <strong>MP4, WebM, MOV, and MKV</strong> files. We re-encode
              everything to HLS with multiple quality levels so playback adapts to each viewer's
              connection speed.
            </p>
            <p>
              The <strong>Free tier</strong> gives you 5 GiB total. The{' '}
              <strong>Creator tier</strong> gives you 500 GiB. Storage counts the original upload
              size — we don't charge extra for the transcoded variants.
            </p>
            <p>
              There's no single-file size cap beyond your remaining quota. If you're encoding
              long-form content, keep individual files under 4 GB for reliable browser uploads.
            </p>
          </div>
        ),
      },
      {
        id: 'captions',
        title: 'Captions & accessibility',
        body: (
          <div className="stack-sm">
            <p>
              spooool can generate automatic captions using AI. After uploading, open the video
              and click the captions menu in the player. Caption generation runs in the background
              and is usually ready within a few minutes for videos under 30 minutes.
            </p>
            <p>
              You can also upload a WebVTT or SRT file if you have manual captions ready.
            </p>
          </div>
        ),
      },
      {
        id: 'visibility',
        title: 'Video visibility',
        body: (
          <div className="stack-sm">
            <p>
              Videos are <strong>public</strong> by default. You can set any video to{' '}
              <strong>private</strong> from the video's edit page — private videos are only
              accessible to you when signed in.
            </p>
            <p>
              If you go over your storage quota, your oldest uploads will be automatically marked
              private until you free up space or upgrade. You'll receive an email notification
              before this happens.
            </p>
          </div>
        ),
      },
    ],
  },
  {
    id: 'monetization',
    title: 'Monetization',
    articles: [
      {
        id: 'tipping',
        title: 'Per-video tipping',
        body: (
          <div className="stack-sm">
            <p>
              Creator-tier accounts can enable tipping on any video. A "Support" button appears
              below the player for logged-in viewers, letting them send a one-time tip of any
              amount.
            </p>
            <p>
              You keep <strong>90%</strong> of every tip. The remaining 10% covers the platform fee
              plus Polar and Stripe's payment processing costs. Payouts are processed through{' '}
              <a href="https://polar.sh" target="_blank" rel="noopener noreferrer" className="ds-link">
                Polar
              </a>
              .
            </p>
            <p>
              Enable tipping from your{' '}
              <Link to="/profile" className="ds-link">Profile settings</Link> once you're on the
              Creator plan.
            </p>
          </div>
        ),
      },
      {
        id: 'memberships',
        title: 'Recurring memberships',
        body: (
          <div className="stack-sm">
            <p>
              Memberships let your most dedicated viewers pay a monthly amount to support your
              channel. You set the price and benefits. Memberships are managed through Polar.
            </p>
            <p>
              Once set up, a "Become a member" option appears on your channel page. You keep 90%
              of membership revenue (same fee structure as tips).
            </p>
          </div>
        ),
      },
      {
        id: 'payouts',
        title: 'Getting paid',
        body: (
          <div className="stack-sm">
            <p>
              Earnings from tips and memberships flow through{' '}
              <a href="https://polar.sh" target="_blank" rel="noopener noreferrer" className="ds-link">
                Polar
              </a>{' '}
              and then to your Stripe account. You'll need to complete Stripe's identity
              verification before withdrawing.
            </p>
            <p>
              Your earnings dashboard is at{' '}
              <Link to="/payouts" className="ds-link">Payouts</Link>. Withdrawals are available
              once your balance exceeds Polar's minimum threshold.
            </p>
          </div>
        ),
      },
    ],
  },
  {
    id: 'privacy',
    title: 'Privacy & account',
    articles: [
      {
        id: 'data',
        title: 'Your data & privacy',
        body: (
          <div className="stack-sm">
            <p>
              We collect only what we need to run the service: your email, uploaded videos, and
              basic usage analytics (with your consent). We don't sell your data or use it to
              target ads.
            </p>
            <p>
              Full details are in our{' '}
              <Link to="/legal/privacy" className="ds-link">Privacy Policy</Link>. You can export
              or delete your data at any time from{' '}
              <Link to="/settings/account" className="ds-link">Account settings</Link>.
            </p>
          </div>
        ),
      },
      {
        id: 'delete-account',
        title: 'Deleting your account',
        body: (
          <div className="stack-sm">
            <p>
              Go to <Link to="/settings/account" className="ds-link">Account settings</Link> and
              scroll to the danger zone. Requesting deletion starts a 30-day grace period — your
              account and content are hidden but not yet purged.
            </p>
            <p>
              During those 30 days you can cancel the deletion by signing back in. After 30 days
              your account, uploads, and all associated data are permanently removed.
            </p>
          </div>
        ),
      },
    ],
  },
  {
    id: 'copyright',
    title: 'Copyright & DMCA',
    articles: [
      {
        id: 'dmca-notice',
        title: 'Reporting copyright infringement',
        body: (
          <div className="stack-sm">
            <p>
              If you believe content on spooool infringes your copyright, you can file a DMCA
              takedown notice at <Link to="/legal/dmca" className="ds-link">/legal/dmca</Link>.
              We review all notices and act within 48 hours.
            </p>
            <p>
              Please include: the URL of the infringing content, a description of the original
              work, your contact information, and a good-faith statement.
            </p>
          </div>
        ),
      },
      {
        id: 'counter-notice',
        title: 'Filing a counter-notice',
        body: (
          <div className="stack-sm">
            <p>
              If your video was taken down and you believe it was a mistake or misidentification,
              you can file a counter-notice at{' '}
              <Link to="/legal/dmca/counter" className="ds-link">/legal/dmca/counter</Link>.
            </p>
            <p>
              After a valid counter-notice is received, we notify the original complainant. If
              they don't seek a court order within 10-14 business days, we'll restore the content.
            </p>
          </div>
        ),
      },
    ],
  },
];

function ArticlePage({ categoryId, articleId }: { categoryId: string; articleId: string }): JSX.Element {
  const category = CATEGORIES.find((c) => c.id === categoryId);
  const article = category?.articles.find((a) => a.id === articleId);

  if (!category || !article) {
    return <Navigate to="/help" replace />;
  }

  return (
    <main className="app-main app-main--narrow stack-lg fade-in">
      <nav className="ds-meta" style={{ display: 'flex', gap: 'var(--space-2)', alignItems: 'center' }}>
        <Link to="/help" className="ds-link">Help Center</Link>
        <span aria-hidden="true">›</span>
        <Link to={`/help/${category.id}`} className="ds-link">{category.title}</Link>
        <span aria-hidden="true">›</span>
        <span>{article.title}</span>
      </nav>

      <article className="card stack">
        <h1 className="ds-h2">{article.title}</h1>
        <div className="stack-sm">{article.body}</div>
      </article>

      <section className="stack-sm">
        <h2 className="ds-h3">More in {category.title}</h2>
        <ul className="stack-sm" style={{ listStyle: 'none', padding: 0, margin: 0 }}>
          {category.articles
            .filter((a) => a.id !== articleId)
            .map((a) => (
              <li key={a.id}>
                <Link to={`/help/${category.id}/${a.id}`} className="ds-link">
                  {a.title}
                </Link>
              </li>
            ))}
        </ul>
      </section>

      <p className="ds-meta">
        Still have questions?{' '}
        <Link to="/contact" className="ds-link">Contact support →</Link>
      </p>
    </main>
  );
}

function CategoryPage({ categoryId }: { categoryId: string }): JSX.Element {
  const category = CATEGORIES.find((c) => c.id === categoryId);

  if (!category) {
    return <Navigate to="/help" replace />;
  }

  return (
    <main className="app-main app-main--narrow stack-lg fade-in">
      <nav className="ds-meta" style={{ display: 'flex', gap: 'var(--space-2)', alignItems: 'center' }}>
        <Link to="/help" className="ds-link">Help Center</Link>
        <span aria-hidden="true">›</span>
        <span>{category.title}</span>
      </nav>

      <section className="stack-sm">
        <h1 className="ds-h2">{category.title}</h1>
        <ul className="stack-sm" style={{ listStyle: 'none', padding: 0, margin: 0 }}>
          {category.articles.map((a) => (
            <li key={a.id}>
              <Link to={`/help/${category.id}/${a.id}`} className="card ds-link" style={{ display: 'block', textDecoration: 'none', color: 'inherit' }}>
                <strong>{a.title}</strong>
              </Link>
            </li>
          ))}
        </ul>
      </section>

      <p className="ds-meta">
        <Link to="/help" className="ds-link">← Back to Help Center</Link>
      </p>
    </main>
  );
}

function HelpIndex(): JSX.Element {
  return (
    <main className="app-main app-main--narrow stack-lg fade-in">
      <section className="stack-sm" style={{ textAlign: 'center', paddingTop: 'var(--space-6)' }}>
        <span className="ds-label">Help Center</span>
        <h1 className="ds-h2">How can we help?</h1>
        <p className="ds-lede" style={{ maxWidth: 520, margin: '0 auto' }}>
          Guides and answers for creators on spooool.
        </p>
      </section>

      <div
        style={{
          display: 'grid',
          gridTemplateColumns: 'repeat(auto-fit, minmax(260px, 1fr))',
          gap: 'var(--space-4)',
        }}
      >
        {CATEGORIES.map((cat) => (
          <article key={cat.id} className="card stack-sm">
            <h2 className="ds-h3" style={{ margin: 0 }}>{cat.title}</h2>
            <ul className="stack-sm" style={{ listStyle: 'none', padding: 0, margin: 0 }}>
              {cat.articles.map((a) => (
                <li key={a.id}>
                  <Link to={`/help/${cat.id}/${a.id}`} className="ds-link">
                    {a.title}
                  </Link>
                </li>
              ))}
            </ul>
          </article>
        ))}
      </div>

      <section className="card stack-sm" style={{ textAlign: 'center', padding: 'var(--space-6)' }}>
        <h2 className="ds-h3" style={{ margin: 0 }}>Still stuck?</h2>
        <p className="ds-meta">
          Our support team usually responds within one business day.
        </p>
        <Link to="/contact" className="btn btn--secondary" style={{ alignSelf: 'center' }}>
          Contact support
        </Link>
      </section>
    </main>
  );
}

export function HelpCenter(): JSX.Element {
  const { categoryId, articleId } = useParams<{ categoryId?: string; articleId?: string }>();

  if (categoryId && articleId) {
    return <ArticlePage categoryId={categoryId} articleId={articleId} />;
  }
  if (categoryId) {
    return <CategoryPage categoryId={categoryId} />;
  }
  return <HelpIndex />;
}
