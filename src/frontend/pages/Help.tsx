// ALO-183: creator-facing help center. Static content shipped with the
// frontend bundle and rendered as React — searchable client-side so we don't
// need a separate docs runtime. Hosted alongside the rest of the SPA on
// Cloudflare Pages.

import { useMemo, useState } from 'react';
import { Link, useParams } from 'react-router-dom';

import { HELP_ARTICLE_SLUGS, type HelpArticleSlug } from '../../shared/helpArticles';

type Section = {
  heading: string;
  body: string[];
};

type Article = {
  slug: HelpArticleSlug;
  title: string;
  blurb: string;
  sections: Section[];
};

const ARTICLES: Article[] = [
  {
    slug: 'quickstart',
    title: 'Quickstart',
    blurb: 'Go from sign-up to first published video in under five minutes.',
    sections: [
      {
        heading: 'Create your account',
        body: [
          'Sign up with an email and password. Verify the address from the email we send — uploads stay locked until your email is confirmed.',
          'Pick a channel handle from your profile page. This is the URL people share to find your videos: spooool.com/channel/your-handle.',
        ],
      },
      {
        heading: 'Upload your first clip',
        body: [
          'Click Upload in the header. Drag an MP4, WebM, MOV, or MKV file onto the drop zone, or pick one from disk.',
          'Add a title, a short description, and any tags that describe the video. Tags help viewers find you on the trending and search pages.',
          'Submit. We transcode in the background — refresh the watch page after a minute or two and the playable stream will be ready.',
        ],
      },
      {
        heading: 'Share it',
        body: [
          'Every video has a permanent /watch/:id URL. Copy it from the address bar or the share button under the player.',
          'Your channel page lists every video you have published, newest first.',
        ],
      },
    ],
  },
  {
    slug: 'upload-guide',
    title: 'Upload guide',
    blurb: 'Supported formats, file-size limits, and what happens after you hit submit.',
    sections: [
      {
        heading: 'Supported containers',
        body: [
          'We accept MP4, WebM, MOV, and MKV. If your file is in a different container (AVI, FLV, WMV), remux it to MP4 first — most editors export MP4 by default.',
        ],
      },
      {
        heading: 'File size and quota',
        body: [
          'Per-file limit: 5 GB. Per-account storage quota depends on your plan and is shown on your profile page.',
          'If an upload fails with a 413 or storage_quota_exceeded error, you have hit your quota. Delete an old video or upgrade.',
        ],
      },
      {
        heading: 'What happens after submit',
        body: [
          'We store the original in R2, then transcode it to streaming-friendly HLS in the background.',
          'While the transcode runs the video is in the "processing" state. You can edit the title, description, and tags during this window.',
          'When the transcode finishes the video flips to "ready" and is playable. Most clips under ten minutes finish in under two minutes.',
          'If something goes wrong the video flips to "failed" with an error code. Check the encoding tips article — most failures are bad source files.',
        ],
      },
      {
        heading: 'Thumbnails',
        body: [
          'We auto-generate a thumbnail from a frame near the start. You can upload a custom JPG or PNG (16:9, 1280x720 recommended) from the video edit page once the transcode is done.',
        ],
      },
    ],
  },
  {
    slug: 'encoding-tips',
    title: 'Encoding tips',
    blurb: 'Source-file settings that transcode reliably and stream beautifully.',
    sections: [
      {
        heading: 'Container and codecs',
        body: [
          'Best results: MP4 container, H.264 video, AAC audio. This is what every modern editor exports by default and what our transcoder handles fastest.',
          'H.265/HEVC is accepted but slower to transcode. AV1 is accepted on newer accounts.',
        ],
      },
      {
        heading: 'Resolution and frame rate',
        body: [
          'Upload at the highest resolution you have — we generate lower-bitrate ladders automatically. Sweet spot: 1080p or 1440p at 24, 30, or 60 fps.',
          'Avoid variable frame rate (VFR) sources. They sometimes desync audio after transcode. Re-encode to constant frame rate first if your camera or screen recorder produces VFR.',
        ],
      },
      {
        heading: 'Bitrate',
        body: [
          'There is no minimum bitrate, but very low-bitrate sources will look soft after transcode. Aim for 8–12 Mbps for 1080p and 16–24 Mbps for 4K source files.',
          'Do not double-compress. Export from your editor at high quality and let us handle the streaming ladder.',
        ],
      },
      {
        heading: 'Audio',
        body: [
          'AAC stereo at 128–192 kbps, 48 kHz sample rate. Mono is fine. Surround tracks are downmixed to stereo.',
          'Normalize loudness to roughly -14 LUFS so your videos sit at a sensible volume next to other clips.',
        ],
      },
      {
        heading: 'Common failure causes',
        body: [
          'Truncated MP4 (the "moov atom" missing) — re-export from your editor.',
          '10-bit video encoded for HDR but flagged as SDR — convert to 8-bit SDR before upload.',
          'Audio sample rate other than 44.1 / 48 kHz — resample to 48 kHz.',
        ],
      },
    ],
  },
  {
    slug: 'monetization-faq',
    title: 'Monetization FAQ',
    blurb: 'How creator payouts work, what content is eligible, and when you get paid.',
    sections: [
      {
        heading: 'How do I earn?',
        body: [
          'Monetization is opt-in per channel. Once enabled, you earn a share of subscription revenue based on watch time on your videos and a cut of any tips viewers send.',
          'You can also enable a "supporters" page on your channel for one-time and recurring tips, processed via Stripe.',
        ],
      },
      {
        heading: 'When do I get paid?',
        body: [
          'Payouts run on the first business day of each month for the previous month\'s earnings, once your balance is at least $25.',
          'Balances under the threshold roll over to the next month. You can see your current balance and history on the profile page.',
        ],
      },
      {
        heading: 'How do I get paid?',
        body: [
          'We pay out via Stripe Connect. Connect your bank account from the account settings page; Stripe handles tax forms and KYC.',
          'Payouts arrive in 2–5 business days depending on your country.',
        ],
      },
      {
        heading: 'What content is eligible?',
        body: [
          'Original content you have the rights to publish. Reuploads of someone else\'s video, content that violates the terms of service, and DMCA-flagged videos are not eligible.',
          'Channels with active strikes are paused from monetization until the strike is resolved.',
        ],
      },
      {
        heading: 'What about taxes?',
        body: [
          'Stripe collects the tax info appropriate for your country (W-9 in the US, W-8BEN elsewhere) when you connect your account. We do not withhold — you are responsible for your own tax filing.',
        ],
      },
    ],
  },
];

// Drift guard: every slug the SEO worker advertises in the sitemap must have
// a rendered article here. Throws at module load so a missing entry is caught
// in CI / dev before reaching production.
for (const slug of HELP_ARTICLE_SLUGS) {
  if (!ARTICLES.some((a) => a.slug === slug)) {
    throw new Error(`Help article missing for slug "${slug}"`);
  }
}

function searchArticles(query: string): Article[] {
  const q = query.trim().toLowerCase();
  if (q.length === 0) return ARTICLES;
  return ARTICLES.filter((a) => {
    if (a.title.toLowerCase().includes(q)) return true;
    if (a.blurb.toLowerCase().includes(q)) return true;
    return a.sections.some(
      (s) =>
        s.heading.toLowerCase().includes(q) ||
        s.body.some((p) => p.toLowerCase().includes(q)),
    );
  });
}

function HelpIndex(): JSX.Element {
  const [query, setQuery] = useState('');
  const results = useMemo(() => searchArticles(query), [query]);

  return (
    <main className="app-main app-main--narrow stack-lg fade-in">
      <section className="stack-sm" style={{ paddingTop: 'var(--space-6)' }}>
        <h1>Help center</h1>
        <p className="ds-lede">
          Guides for creators on spooool — how to upload, how to encode, and how to get paid.
        </p>
        <form
          role="search"
          onSubmit={(e) => e.preventDefault()}
          style={{ marginTop: 'var(--space-3)' }}
        >
          <input
            type="search"
            aria-label="Search help articles"
            placeholder="Search the help center…"
            className="input"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            style={{ width: '100%' }}
          />
        </form>
      </section>

      <section className="stack-sm" aria-label="Articles">
        {results.length === 0 ? (
          <p className="ds-empty">
            No articles match &ldquo;{query}&rdquo;. Try a different term, or{' '}
            <a href="mailto:help@spooool.com">email us</a>.
          </p>
        ) : (
          <div
            style={{
              display: 'grid',
              gridTemplateColumns: 'repeat(auto-fit, minmax(260px, 1fr))',
              gap: 'var(--space-3)',
            }}
          >
            {results.map((a) => (
              <Link key={a.slug} to={`/help/${a.slug}`} className="suggestion-card">
                <div style={{ fontWeight: 700, fontSize: 'var(--text-base)' }}>{a.title}</div>
                <div className="ds-meta" style={{ marginTop: 4 }}>
                  {a.blurb}
                </div>
              </Link>
            ))}
          </div>
        )}
      </section>

      <section className="ds-meta" aria-label="Contact">
        Still stuck? Email <a href="mailto:help@spooool.com">help@spooool.com</a>.
      </section>
    </main>
  );
}

function HelpArticle({ article }: { article: Article }): JSX.Element {
  return (
    <main className="app-main app-main--narrow stack-lg fade-in">
      <p className="ds-meta" style={{ marginTop: 'var(--space-4)' }}>
        <Link to="/help">← Help center</Link>
      </p>
      <h1>{article.title}</h1>
      <p className="ds-lede">{article.blurb}</p>
      {article.sections.map((s) => (
        <section key={s.heading} className="stack-sm">
          <h2 className="ds-h3" style={{ marginTop: 'var(--space-4)' }}>{s.heading}</h2>
          {s.body.map((p, i) => (
            <p key={i}>{p}</p>
          ))}
        </section>
      ))}
      <p className="ds-meta" style={{ paddingTop: 'var(--space-6)' }}>
        Was this article helpful? Email <a href="mailto:help@spooool.com">help@spooool.com</a>{' '}
        with feedback or a question we should add.
      </p>
    </main>
  );
}

export function Help(): JSX.Element {
  const { slug } = useParams<{ slug?: string }>();
  if (!slug) return <HelpIndex />;
  const article = ARTICLES.find((a) => a.slug === slug);
  if (!article) {
    return (
      <main className="app-main app-main--narrow stack-lg fade-in">
        <h1>Article not found</h1>
        <p>
          We couldn&apos;t find that help article. Head back to the{' '}
          <Link to="/help">help center</Link>.
        </p>
      </main>
    );
  }
  return <HelpArticle article={article} />;
}
