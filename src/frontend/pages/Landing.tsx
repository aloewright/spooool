import { Suspense, lazy, useEffect, useState } from 'react';
import { Link } from 'react-router-dom';

// ALO-177: marketing landing for spooool.com — anonymous-only surface.
// LCP target is the hero <h1>; no above-the-fold images, no eager video.
// The sample player is a click-to-play poster that defers loading the
// HLS player + manifest until the visitor opts in, keeping the initial
// payload identical to the rest of the home shell.
const SamplePlayer = lazy(() =>
  import('../components/SamplePlayer').then((m) => ({ default: m.SamplePlayer })),
);

type FeaturedVideo = {
  id: string;
  title: string;
  channel_name?: string | null;
  thumbnail_url?: string | null;
};

const FEATURES: { title: string; body: string }[] = [
  {
    title: 'Stream from the edge',
    body: 'Cloudflare Stream + R2 means viewers start playing in milliseconds, anywhere on earth.',
  },
  {
    title: 'No ads, no dark patterns',
    body: 'No pre-rolls, no autoplay-into-the-feed, no engagement loops. Watch and leave.',
  },
  {
    title: 'Creators keep their work',
    body: 'Original files stay in R2. Export anytime. Your channel, your URL.',
  },
  {
    title: 'Built to be fast',
    body: 'A 14 kB JS shell, real-route splitting, instant resume. Performance is a feature.',
  },
];

export function Landing(): JSX.Element {
  // ALO-177: lift one trending video for the sample player so the demo
  // showcases real content without needing a hard-coded sample manifest.
  // Falls back to a static poster when there isn't one yet.
  const [featured, setFeatured] = useState<FeaturedVideo | null>(null);

  useEffect(() => {
    let cancelled = false;
    void fetch('/api/videos/trending?limit=1')
      .then(async (response) => {
        if (!response.ok) return null;
        const data = (await response.json()) as { videos: FeaturedVideo[] };
        return data.videos[0] ?? null;
      })
      .then((v) => {
        if (!cancelled && v) setFeatured(v);
      })
      .catch(() => undefined);
    return () => {
      cancelled = true;
    };
  }, []);

  return (
    <main className="landing fade-in">
      <section className="landing__hero">
        <span className="ds-label">A video host that respects your time</span>
        <h1 className="landing__hero-title">
          Upload, stream, share —<br />
          <em className="landing__hero-emphasis">no friction.</em>
        </h1>
        <p className="landing__hero-lede">
          spooool is a fast, ad-free video host built on Cloudflare. Drop in an MP4. Get a
          shareable link in seconds.
        </p>
        <div className="landing__hero-cta">
          <Link to="/signup" className="btn btn--lg" role="button">
            Sign up free
          </Link>
          <Link to="/login" className="btn btn--secondary btn--lg" role="button">
            Sign in
          </Link>
        </div>
        <p className="ds-meta landing__hero-foot">
          No credit card. Free tier includes 1 GB of storage.
        </p>
      </section>

      <section className="landing__section" aria-labelledby="features-heading">
        <h2 id="features-heading" className="ds-h2">Why spooool</h2>
        <div className="landing__features">
          {FEATURES.map((f) => (
            <article key={f.title} className="card landing__feature">
              <h3 className="ds-h3">{f.title}</h3>
              <p>{f.body}</p>
            </article>
          ))}
        </div>
      </section>

      <section className="landing__section" aria-labelledby="sample-heading">
        <h2 id="sample-heading" className="ds-h2">See it in action</h2>
        <p className="ds-lede landing__section-lede">
          A real video, played on the same edge network you'd be uploading to.
        </p>
        <Suspense fallback={<div className="landing__sample-fallback" aria-hidden="true" />}>
          <SamplePlayer
            videoId={featured?.id ?? null}
            posterUrl={featured?.thumbnail_url ?? null}
            title={featured?.title ?? null}
            channel={featured?.channel_name ?? null}
          />
        </Suspense>
      </section>

      <section className="landing__cta" aria-labelledby="cta-heading">
        <h2 id="cta-heading" className="ds-h2">Get a channel in 30 seconds</h2>
        <p className="ds-lede" style={{ maxWidth: 520, margin: '0 auto' }}>
          Email and a password. That's the whole signup. You can upload your first clip on the
          next screen.
        </p>
        <div className="landing__hero-cta">
          <Link to="/signup" className="btn btn--lg" role="button">
            Create your channel
          </Link>
        </div>
      </section>

      <footer className="landing__footer ds-meta">
        <Link to="/legal/tos">Terms of Service</Link>
        <Link to="/legal/privacy">Privacy Policy</Link>
        <Link to="/legal/dmca">DMCA</Link>
      </footer>
    </main>
  );
}
