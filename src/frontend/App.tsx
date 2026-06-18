import { lazy, useEffect, useState, type JSX } from 'react';
import { Link, useNavigate, type LinkProps } from '@tanstack/react-router';
import { LogOut, Moon, Settings, Sun, Upload as UploadIconLucide, UserCircle2 } from 'lucide-react';
import { useSearchParams } from './lib/use-search-params';
import { signOut, useSession } from './lib/auth-client';
import { ChannelIcon, PlayIcon, UploadIcon, VideoPlaceholderIcon } from './components/Icons';
import { NotificationBell } from './components/NotificationBell';
import './styles/strand.css';

// Route-level code splitting lives in router.tsx (the page components are
// lazy()-imported there and rendered under <Suspense>). App.tsx now only
// holds the shell building blocks (header, footer, splash, Home) plus the
// StudioHub handoff, all consumed by the code-based route tree in router.tsx.
// History: ALO-199 set up the split; ALO-204 swapped hls.js for video.js;
// we then ripped both out in favour of @cloudflare/stream-react once playback
// was unified on Cloudflare Stream; phase 3b migrated the tree to TanStack
// Router (this file's route tree moved to router.tsx).
const Studio = lazy(() => import('./pages/Studio').then((m) => ({ default: m.Studio })));

// Shared Suspense fallback for the shell's <Outlet/> (router.tsx) and the
// 404 component.
export function RouteFallback(): JSX.Element {
  return (
    <main className="app-main stack">
      <p className="ds-meta">Loading…</p>
    </main>
  );
}

type TrendingVideo = {
  id: string;
  title: string;
  description: string;
  channel_name?: string | null;
  thumbnail_url?: string | null;
  view_count: number;
  recent_views?: number;
};

type HistoryItem = {
  video_id: string;
  watched_at: string;
  title: string;
  thumbnail_url: string | null;
  view_count: number;
  channel_name: string | null;
  channel_username: string | null;
};

function SpoolWave({
  fontPx,
  paced = false,
}: {
  fontPx: number;
  paced?: boolean;
}): JSX.Element {
  // Cursive-script "loop-dee-loop" path translated 1:1 from the lottie
  // spiral bezier data. Each loop is 4 cubic segments; we repeat the
  // pattern 6× across a 0..48 viewBox so dashoffset can scroll the
  // visible window continuously. viewBox aspect (4:1) matches the
  // rendered box so preserveAspectRatio="none" doesn't distort. Loops
  // sit AT the text baseline going UP (y=12 = baseline, y=0 = x-height).
  const width = Math.round(fontPx * 2);
  const height = Math.round(fontPx * 0.5);
  const loops = [0, 8, 16, 24, 32, 40]
    .map((x) => {
      return [
        `C ${x + 4.452} 12, ${x + 6.736} 8.284, ${x + 7.025} 4.988`,
        `C ${x + 7.255} 2.361, ${x + 6.218} 0, ${x + 4} 0`,
        `C ${x + 1.782} 0, ${x + 0.745} 2.361, ${x + 0.975} 4.988`,
        `C ${x + 1.264} 8.284, ${x + 3.548} 12, ${x + 8} 12`,
      ].join(' ');
    })
    .join(' ');
  return (
    <svg
      viewBox="0 0 48 12"
      width={width}
      height={height}
      preserveAspectRatio="none"
      aria-hidden="true"
      style={{ display: 'inline-block', verticalAlign: 'baseline', overflow: 'visible' }}
    >
      <path
        d={`M 0 12 ${loops}`}
        fill="none"
        stroke="currentColor"
        strokeWidth={fontPx * 0.04}
        strokeLinecap="round"
        strokeLinejoin="round"
        pathLength={100}
        className={paced ? 'spooool-wave--paced' : 'spooool-wave'}
      />
    </svg>
  );
}

function Wordmark({ size = 'lg' }: { size?: 'lg' | 'sm' }): JSX.Element {
  // Plain text title set in Nunito (via .ds-wordmark) — no per-letter motion.
  return (
    <Link
      to="/"
      aria-label="spooool"
      className={size === 'sm' ? 'ds-wordmark ds-wordmark--sm' : 'ds-wordmark'}
    >
      spooool
    </Link>
  );
}

const SPLASH_DURATION_MS = 3200;
const SPLASH_FADE_MS = 600;

function Splash({ onDone }: { onDone: () => void }): JSX.Element {
  const [leaving, setLeaving] = useState(false);

  useEffect(() => {
    const dismiss = window.setTimeout(() => setLeaving(true), SPLASH_DURATION_MS);
    return () => window.clearTimeout(dismiss);
  }, []);

  useEffect(() => {
    if (!leaving) return;
    const finish = window.setTimeout(onDone, SPLASH_FADE_MS);
    return () => window.clearTimeout(finish);
  }, [leaving, onDone]);

  // Click-to-skip — start the leave animation immediately.
  const skip = () => setLeaving(true);

  // Splash mark gets its own font sizing (clamp() on the wrapper) so the
  // SVG width tracks the rendered font size. We size the wave at a
  // representative middle value; CSS clamps the mark itself.
  const splashFontPx = 120;
  return (
    <div
      className={leaving ? 'splash splash--leaving' : 'splash'}
      onClick={skip}
      role="button"
      tabIndex={0}
      onKeyDown={(e) => {
        if (e.key === 'Enter' || e.key === ' ') skip();
      }}
      aria-label="spooool — tap to enter"
    >
      <span className="splash__mark">
        <span aria-hidden="true">sp</span>
        <SpoolWave fontPx={splashFontPx} paced />
        <span aria-hidden="true" style={{ marginLeft: '-0.05em' }}>l</span>
      </span>
      <span className="splash__hint">tap to enter</span>
    </div>
  );
}

function HeaderNav(): JSX.Element {
  const { data: session, isPending } = useSession();
  const navigate = useNavigate();

  if (isPending) {
    return <span className="ds-meta">…</span>;
  }

  if (!session) {
    return (
      <nav className="app-header__nav">
        <Link to="/login">
          <button type="button" className="btn btn--ghost btn--sm">Sign in</button>
        </Link>
        <Link to="/signup">
          <button type="button" className="btn btn--secondary btn--sm">Sign up</button>
        </Link>
      </nav>
    );
  }

  const iconBtn: React.CSSProperties = {
    display: 'inline-flex',
    alignItems: 'center',
    justifyContent: 'center',
    width: 32,
    height: 32,
    borderRadius: '9999px',
    border: 'none',
    background: 'transparent',
    color: 'var(--foreground)',
    cursor: 'pointer',
    padding: 0,
  };
  return (
    <nav className="app-header__nav">
      <NotificationBell />
      <Link to="/payouts">
        <button type="button" className="btn btn--ghost btn--sm">Payouts</button>
      </Link>
      <Link to="/feeds">
        <button type="button" className="btn btn--ghost btn--sm">Feeds</button>
      </Link>
      <Link to="/discover">
        <button type="button" className="btn btn--ghost btn--sm">Discover</button>
      </Link>
      {/* Studio is the content hub served by the `editor` worker via the
          spooool.com/studio* zone route — hard link / full page load so the
          zone route wins (falls back to the in-app Studio if it's not live). */}
      <a href="/studio">
        <button type="button" className="btn btn--ghost btn--sm">Studio</button>
      </a>
      <Link to="/upload" aria-label="Upload" title={`Upload — ${session.user?.email ?? ''}`} style={iconBtn}>

        <UploadIconLucide aria-hidden="true" width={20} height={20} strokeWidth={1.5} />
      </Link>
      <Link to="/profile" aria-label="Profile" title={`Profile — ${session.user?.email ?? ''}`} style={iconBtn}>
        <UserCircle2 aria-hidden="true" width={20} height={20} strokeWidth={1.5} />
      </Link>
      <Link to="/settings/account" aria-label="Account settings" title="Account settings" style={iconBtn}>
        <Settings aria-hidden="true" width={20} height={20} strokeWidth={1.5} />
      </Link>
      <button
        type="button"
        aria-label="Sign out"
        title="Sign out"
        style={iconBtn}
        onClick={() => {
          // ALO-166: tear down the PostHog identity before navigating so
          // the next visitor on a shared device starts a fresh session.
          void import('./lib/analytics').then(({ reset }) => reset());
          void signOut().then(() => navigate({ to: '/', replace: true }));
        }}
      >
        <LogOut aria-hidden="true" width={20} height={20} strokeWidth={1.5} />
      </button>
    </nav>
  );
}

function HeaderSearch(): JSX.Element {
  const navigate = useNavigate();
  const [params] = useSearchParams();
  const initial = params.get('q') ?? '';
  const [value, setValue] = useState(initial);

  useEffect(() => {
    setValue(initial);
  }, [initial]);

  return (
    <form
      role="search"
      className="app-header__search"
      onSubmit={(e) => {
        e.preventDefault();
        const q = value.trim();
        if (q.length === 0) return;
        void navigate({ to: '/search', search: { q } });
      }}
    >
      <input
        type="search"
        name="q"
        aria-label="Search videos"
        placeholder="Search videos…"
        className="input input--sm"
        value={value}
        onChange={(e) => setValue(e.target.value)}
      />
    </form>
  );
}

type Theme = 'light' | 'dark';

function getInitialTheme(): Theme {
  if (typeof window === 'undefined') return 'light';
  try {
    const stored = window.localStorage?.getItem('theme');
    if (stored === 'light' || stored === 'dark') return stored;
  } catch {
    // Storage can be unavailable in hardened browsers and DOM test runtimes.
  }
  return window.matchMedia?.('(prefers-color-scheme: dark)').matches ? 'dark' : 'light';
}

function ThemeToggle(): JSX.Element {
  const [theme, setTheme] = useState<Theme>(getInitialTheme);

  useEffect(() => {
    const root = document.documentElement;
    root.classList.toggle('dark', theme === 'dark');
    root.style.colorScheme = theme;
    try {
      window.localStorage?.setItem('theme', theme);
    } catch {
      // Ignore storage failures; the in-memory theme state still applies.
    }
  }, [theme]);

  // Springy cross-fade between Sun and Moon. Both glyphs are absolutely
  // positioned in the same 32px slot; only opacity / translateY / scale
  // change so the transition reads as a single icon morphing.
  const ease = 'cubic-bezier(0.34, 1.56, 0.64, 1)';
  const iconBase: React.CSSProperties = {
    position: 'absolute',
    width: 20,
    height: 20,
    transition: `opacity 300ms ${ease}, transform 300ms ${ease}`,
  };
  return (
    <button
      type="button"
      onClick={() => setTheme((t) => (t === 'dark' ? 'light' : 'dark'))}
      aria-label={`Switch to ${theme === 'dark' ? 'light' : 'dark'} mode`}
      title={`Switch to ${theme === 'dark' ? 'light' : 'dark'} mode`}
      style={{
        position: 'relative',
        display: 'inline-flex',
        alignItems: 'center',
        justifyContent: 'center',
        width: 32,
        height: 32,
        borderRadius: '9999px',
        border: 'none',
        background: 'transparent',
        color: 'var(--foreground)',
        cursor: 'pointer',
        overflow: 'hidden',
        padding: 0,
      }}
    >
      <Sun
        aria-hidden="true"
        style={{
          ...iconBase,
          opacity: theme === 'light' ? 1 : 0,
          transform: theme === 'light' ? 'translateY(0) scale(1)' : 'translateY(20px) scale(0.5)',
        }}
      />
      <Moon
        aria-hidden="true"
        style={{
          ...iconBase,
          opacity: theme === 'dark' ? 1 : 0,
          transform: theme === 'dark' ? 'translateY(0) scale(1)' : 'translateY(20px) scale(0.5)',
        }}
      />
    </button>
  );
}

export function AppHeader(): JSX.Element {
  return (
    <header className="app-header">
      <Wordmark size="sm" />
      <HeaderSearch />
      <div style={{ display: 'flex', alignItems: 'center', gap: 'var(--space-2)' }}>
        <ThemeToggle />
        <HeaderNav />
      </div>
    </header>
  );
}

// `link` holds TanStack Link navigation props (typed `to` + dynamic `params`)
// spread directly onto <Link>. Preserves the original concrete targets
// (/upload, /channel/explore, /watch/demo) now that dynamic segments use
// the $param form.
const SUGGESTIONS: {
  title: string;
  helper: string;
  link: LinkProps;
  Icon: (props: { className?: string; style?: React.CSSProperties }) => JSX.Element;
}[] = [
  { title: 'Upload a clip', helper: 'Drop in an MP4, WebM, MOV, or MKV.', link: { to: '/upload' }, Icon: UploadIcon },
  { title: 'Open a channel', helper: 'Visit a creator and skim their library.', link: { to: '/channel/$username', params: { username: 'explore' } }, Icon: ChannelIcon },
  { title: 'Watch something', helper: 'Jump into a video by id.', link: { to: '/watch/$id', params: { id: 'demo' } }, Icon: PlayIcon },
];

function TrendingCard({ video }: { video: TrendingVideo }): JSX.Element {
  return (
    <Link to="/watch/$id" params={{ id: video.id }} className="suggestion-card">
      {video.thumbnail_url ? (
        <img
          src={video.thumbnail_url}
          alt=""
          loading="lazy"
          decoding="async"
          style={{
            width: '100%',
            aspectRatio: '16/9',
            objectFit: 'cover',
            borderRadius: 8,
            marginBottom: 'var(--space-2)',
          }}
        />
      ) : (
        <VideoPlaceholderIcon />
      )}
      <div style={{ fontWeight: 700, fontSize: 'var(--text-base)' }}>{video.title}</div>
      <div className="ds-meta" style={{ marginTop: 4 }}>
        {video.channel_name ?? 'Unknown channel'} · {video.view_count} views
      </div>
    </Link>
  );
}

function HistoryCard({ item }: { item: HistoryItem }): JSX.Element {
  return (
    <Link to="/watch/$id" params={{ id: item.video_id }} className="suggestion-card">
      {item.thumbnail_url ? (
        <img
          src={item.thumbnail_url}
          alt=""
          loading="lazy"
          decoding="async"
          style={{
            width: '100%',
            aspectRatio: '16/9',
            objectFit: 'cover',
            borderRadius: 8,
            marginBottom: 'var(--space-2)',
          }}
        />
      ) : (
        <VideoPlaceholderIcon />
      )}
      <div style={{ fontWeight: 700, fontSize: 'var(--text-base)' }}>{item.title}</div>
      <div className="ds-meta" style={{ marginTop: 4 }}>
        {item.channel_name ?? 'Unknown channel'} · {item.view_count} views
      </div>
    </Link>
  );
}

export function Home(): JSX.Element {
  const { data: session } = useSession();
  const [trending, setTrending] = useState<TrendingVideo[] | null>(null);
  const [trendingError, setTrendingError] = useState<string | null>(null);
  const [history, setHistory] = useState<HistoryItem[] | null>(null);
  const [clearing, setClearing] = useState(false);

  useEffect(() => {
    let cancelled = false;
    void fetch('/api/videos/trending?limit=12')
      .then(async (response) => {
        if (!response.ok) {
          throw new Error('Failed to load trending videos');
        }
        return (await response.json()) as { videos: TrendingVideo[] };
      })
      .then((data) => {
        if (!cancelled) {
          setTrending(data.videos);
        }
      })
      .catch((err: unknown) => {
        if (!cancelled) {
          setTrendingError(err instanceof Error ? err.message : 'Unknown error');
        }
      });
    return () => {
      cancelled = true;
    };
  }, []);

  // ALO-145: load the signed-in user's recent watch history. Skipped when
  // anonymous so the unauth Home stays a single round-trip.
  useEffect(() => {
    if (!session?.user) {
      setHistory(null);
      return;
    }
    let cancelled = false;
    void fetch('/api/users/me/history?limit=8', { credentials: 'same-origin' })
      .then(async (r) => {
        if (!r.ok) throw new Error('Failed to load history');
        return (await r.json()) as { items: HistoryItem[] };
      })
      .then((data) => {
        if (!cancelled) setHistory(data.items);
      })
      .catch(() => {
        if (!cancelled) setHistory([]);
      });
    return () => {
      cancelled = true;
    };
  }, [session?.user]);

  const clearHistory = async (): Promise<void> => {
    setClearing(true);
    try {
      const res = await fetch('/api/users/me/history', {
        method: 'DELETE',
        credentials: 'same-origin',
      });
      if (res.ok) setHistory([]);
    } finally {
      setClearing(false);
    }
  };

  return (
    <main className="app-main app-main--narrow stack-lg fade-in">
      {!session?.user ? (
        <section
          className="stack"
          style={{
            alignItems: 'center',
            textAlign: 'center',
            paddingTop: 'var(--space-10)',
            paddingBottom: 'var(--space-6)',
          }}
        >
          <h1
            style={{
              fontSize: 'clamp(var(--text-3xl), 5vw, var(--text-5xl))',
              fontWeight: 800,
              lineHeight: 1.15,
              letterSpacing: '-0.02em',
              margin: 0,
              maxWidth: 600,
            }}
          >
            Your video.
            <br />
            Your audience.
            <br />
            No nonsense.
          </h1>
          <p className="ds-lede" style={{ maxWidth: 520, margin: '0 auto' }}>
            Creator-first video hosting — adaptive streaming, channel pages, memberships, and
            tipping. No ads. No algorithm fighting you.
          </p>
          <div style={{ display: 'flex', gap: 'var(--space-3)', flexWrap: 'wrap', justifyContent: 'center' }}>
            <Link to="/signup" className="btn">Sign up free</Link>
            <Link to="/pricing" className="btn btn--secondary">See pricing</Link>
          </div>

          <div
            style={{
              display: 'grid',
              gridTemplateColumns: 'repeat(auto-fit, minmax(180px, 1fr))',
              gap: 'var(--space-4)',
              marginTop: 'var(--space-4)',
              width: '100%',
              textAlign: 'left',
            }}
          >
            {[
              {
                emoji: '🎬',
                title: 'Upload & stream',
                body: 'Adaptive bitrate HLS playback, anywhere. 5 GiB free.',
              },
              {
                emoji: '📡',
                title: 'Build your audience',
                body: 'Subscriptions, comments, tags, search, and watch history.',
              },
              {
                emoji: '💸',
                title: 'Earn from your work',
                body: 'Tips and recurring memberships on the Creator plan.',
              },
            ].map(({ emoji, title, body }) => (
              <article key={title} className="card stack-sm">
                <span style={{ fontSize: 'var(--text-2xl)' }}>{emoji}</span>
                <h3 style={{ margin: 0, fontWeight: 700, fontSize: 'var(--text-base)' }}>{title}</h3>
                <p className="ds-meta" style={{ margin: 0 }}>{body}</p>
              </article>
            ))}
          </div>
        </section>
      ) : (
        <section
          className="stack-sm"
          style={{
            alignItems: 'center',
            textAlign: 'center',
            paddingTop: 'var(--space-6)',
            paddingBottom: 'var(--space-2)',
          }}
        >
          <p className="ds-lede" style={{ maxWidth: 480, margin: '0 auto' }}>
            A video host that respects your time. Upload, stream, share — no friction.
          </p>
        </section>
      )}

      {session?.user && history !== null && history.length > 0 ? (
        <section className="stack-sm" aria-label="Continue watching">
          <div style={{ display: 'flex', alignItems: 'baseline', justifyContent: 'space-between', gap: 'var(--space-2)' }}>
            <h2 className="ds-h3" style={{ margin: 0 }}>Continue watching</h2>
            <button
              type="button"
              className="ds-btn ds-btn--ghost ds-btn--sm"
              onClick={() => void clearHistory()}
              disabled={clearing}
            >
              {clearing ? 'Clearing…' : 'Clear history'}
            </button>
          </div>
          <div
            style={{
              display: 'grid',
              gridTemplateColumns: 'repeat(auto-fit, minmax(220px, 1fr))',
              gap: 'var(--space-3)',
            }}
          >
            {history.map((item) => (
              <HistoryCard key={item.video_id} item={item} />
            ))}
          </div>
        </section>
      ) : null}

      <section className="stack-sm" aria-label="Trending">
        <h2 className="ds-h3" style={{ margin: 0 }}>Trending this week</h2>
        {trendingError ? (
          <p className="status-error">{trendingError}</p>
        ) : trending === null ? (
          <p className="ds-empty">Loading…</p>
        ) : trending.length === 0 ? (
          <p className="ds-empty">No trending videos yet — be the first to upload.</p>
        ) : (
          <div
            style={{
              display: 'grid',
              gridTemplateColumns: 'repeat(auto-fit, minmax(220px, 1fr))',
              gap: 'var(--space-3)',
            }}
          >
            {trending.map((video) => (
              <TrendingCard key={video.id} video={video} />
            ))}
          </div>
        )}
      </section>

      <section
        className="stack-sm"
        aria-label="Get started"
        style={{
          paddingTop: 'var(--space-8)',
          paddingLeft: 'var(--space-4)',
          paddingRight: 'var(--space-4)',
          marginTop: 'var(--space-6)',
        }}
      >
        <h2 className="ds-h3" style={{ margin: 0, marginBottom: 'var(--space-4)' }}>Start here</h2>
        <div className="suggestion-grid">
          {SUGGESTIONS.map((item, i) => (
            <Link
              key={item.title}
              {...item.link}
              className="suggestion-card suggestion-card--glow"
              // Hover-only border-trace; per-card duration so consecutive
              // hovers feel slightly different.
              style={
                {
                  '--trace-duration': ['1.6s', '2s', '1.8s'][i],
                } as React.CSSProperties
              }
            >
              <span className="suggestion-card__border" aria-hidden="true">
                <span className="suggestion-card__shine" />
              </span>
              <div
                style={{
                  display: 'flex',
                  alignItems: 'center',
                  justifyContent: 'center',
                  width: 44,
                  height: 44,
                  borderRadius: 10,
                  marginBottom: 'var(--space-2)',
                }}
              >
                <item.Icon />
              </div>
              <div style={{ fontWeight: 700, fontSize: 'var(--text-base)' }}>{item.title}</div>
              <div className="ds-meta" style={{ marginTop: 4 }}>
                {item.helper}
              </div>
            </Link>
          ))}
        </div>
      </section>
    </main>
  );
}

// ALO-405: rendered at the bottom of the app shell so every route — not just
// Home — exposes the legal + pricing links. GDPR / ToS / DMCA links must be
// reachable from /watch, /channel, /settings, etc., not only from /.
export function SiteFooter(): JSX.Element {
  return (
    <footer
      className="app-footer ds-meta"
      style={{
        display: 'flex',
        justifyContent: 'center',
        gap: 'var(--space-4)',
        padding: 'var(--space-6) var(--space-4)',
        borderTop: '1px solid var(--border)',
      }}
    >
      <Link to="/legal/tos">Terms of Service</Link>
      <Link to="/legal/privacy">Privacy Policy</Link>
      <Link to="/pricing">Pricing</Link>
      <Link to="/legal/dmca">DMCA</Link>
      <Link to="/status">Status</Link>
    </footer>
  );
}

function useSplash(): { show: boolean; dismiss: () => void } {
  // First-visit splash. sessionStorage scopes it per browser tab session
  // so users don't see it on every internal navigation.
  const [show, setShow] = useState<boolean>(() => {
    if (typeof window === 'undefined') return false;
    if (window.location.pathname !== '/') return false;
    return window.sessionStorage.getItem('splash:seen') !== '1';
  });
  const dismiss = () => {
    window.sessionStorage.setItem('splash:seen', '1');
    setShow(false);
  };
  return { show, dismiss };
}

// The content hub (writing studio + AI Studio, spec
// docs/superpowers/specs/studio-content-hub.md) is served by the `editor`
// worker via the spooool.com/studio* zone route. spooool hands `/studio` off
// with a full page load (the nav uses a hard <a> link) so the zone route
// always wins, and this component never runs in healthy prod.
//
// It ONLY runs when the SPA itself served `/studio` — i.e. the zone route is
// not intercepting (local dev, or before the editor worker is deployed). The
// previous version unconditionally re-issued `window.location.replace('/studio')`,
// which re-served the SPA and looped forever, breaking the site. This version
// hands off at most once (sessionStorage guard); if the reload lands back on
// the SPA, it stops and renders the in-app Studio as a graceful fallback.
export function StudioHub(): JSX.Element | null {
  const [fallback, setFallback] = useState(false);
  useEffect(() => {
    const KEY = 'studio:handoff';
    // sessionStorage can throw when storage is disabled/partitioned (private
    // mode, sandboxed iframes). Since this guard is the only thing preventing
    // an infinite handoff loop, treat any storage failure as "can't guard" and
    // degrade straight to the in-app Studio rather than risk looping.
    let alreadyTried: boolean;
    try {
      alreadyTried = sessionStorage.getItem(KEY) !== null;
      if (alreadyTried) sessionStorage.removeItem(KEY);
      else sessionStorage.setItem(KEY, '1');
    } catch {
      setFallback(true);
      return;
    }
    if (alreadyTried) {
      // We already tried the handoff and came back → the zone route isn't
      // intercepting. Don't loop; degrade to the in-app Studio.
      setFallback(true);
      return;
    }
    window.location.replace('/studio');
  }, []);
  return fallback ? <Studio /> : null;
}

// First-visit splash gate. Wraps the app shell (and the 404 component) in
// router.tsx: shows the full-screen Splash on the very first visit to `/`,
// then renders its children (the shell) once dismissed. Splits the old
// default-export `App` so the shell can be a TanStack pathless layout route
// while the splash behavior is preserved exactly (sessionStorage-scoped,
// path-gated to `/`, click/timeout to dismiss).
export function SplashGate({ children }: { children: JSX.Element }): JSX.Element {
  const splash = useSplash();
  if (splash.show) {
    return <Splash onDone={splash.dismiss} />;
  }
  return children;
}
