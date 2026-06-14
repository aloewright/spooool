import { lazy, Suspense, useEffect, useState } from 'react';
import { Link, Navigate, Route, Routes, useLocation, useNavigate, useSearchParams } from 'react-router-dom';
import { LogOut, Moon, Settings, Sun, Upload as UploadIconLucide, UserCircle2 } from 'lucide-react';
import { MantineProvider } from '@mantine/core';
import '@mantine/core/styles.css';
import { signOut, useSession } from './lib/auth-client';
import { ChannelIcon, PlayIcon, UploadIcon, VideoPlaceholderIcon } from './components/Icons';
import { NotificationBell } from './components/NotificationBell';
import './styles/strand.css';

// Route-level code splitting: each page (and the @cloudflare/stream-react
// SDK loader the /watch chunk depends on) is fetched only when navigated to.
// Cuts the initial JS payload on the home route to the React-vendor + Home
// shell. History: ALO-199 set up the split; ALO-204 swapped hls.js for
// video.js; we then ripped both out in favour of @cloudflare/stream-react
// once playback was unified on Cloudflare Stream.
const Watch = lazy(() => import('./pages/Watch').then((m) => ({ default: m.Watch })));
const Upload = lazy(() => import('./pages/Upload').then((m) => ({ default: m.Upload })));
const Login = lazy(() => import('./pages/Login').then((m) => ({ default: m.Login })));
const Signup = lazy(() => import('./pages/Signup').then((m) => ({ default: m.Signup })));
const Profile = lazy(() => import('./pages/Profile').then((m) => ({ default: m.Profile })));
const Channel = lazy(() => import('./pages/Channel').then((m) => ({ default: m.Channel })));
const Search = lazy(() => import('./pages/Search').then((m) => ({ default: m.Search })));
const AdminModeration = lazy(() =>
  import('./pages/AdminModeration').then((m) => ({ default: m.AdminModeration })),
);
const AdminRoles = lazy(() =>
  import('./pages/AdminRoles').then((m) => ({ default: m.AdminRoles })),
);
const AccountSettings = lazy(() =>
  import('./pages/AccountSettings').then((m) => ({ default: m.AccountSettings })),
);
const Tag = lazy(() => import('./pages/Tag').then((m) => ({ default: m.Tag })));
const DmcaForm = lazy(() => import('./pages/DmcaForm').then((m) => ({ default: m.DmcaForm })));
const DmcaCounter = lazy(() => import('./pages/DmcaCounter').then((m) => ({ default: m.DmcaCounter })));
const DmcaNotice = lazy(() => import('./pages/DmcaNotice').then((m) => ({ default: m.DmcaNotice })));
const Tos = lazy(() => import('./pages/Tos').then((m) => ({ default: m.Tos })));
const Privacy = lazy(() => import('./pages/Privacy').then((m) => ({ default: m.Privacy })));
const ForgotPassword = lazy(() =>
  import('./pages/ForgotPassword').then((m) => ({ default: m.ForgotPassword })),
);
const ResetPassword = lazy(() =>
  import('./pages/ResetPassword').then((m) => ({ default: m.ResetPassword })),
);
const Onboarding = lazy(() =>
  import('./pages/Onboarding').then((m) => ({ default: m.Onboarding })),
);
const Pricing = lazy(() => import('./pages/Pricing').then((m) => ({ default: m.Pricing })));
const NotFound = lazy(() => import('./pages/NotFound').then((m) => ({ default: m.NotFound })));
const Record = lazy(() => import('./pages/Record').then((m) => ({ default: m.Record })));
const Create = lazy(() => import('./pages/Create').then((m) => ({ default: m.Create })));
const Subscriptions = lazy(() =>
  import('./pages/Subscriptions').then((m) => ({ default: m.Subscriptions })),
);
const Payouts = lazy(() => import('./pages/Payouts').then((m) => ({ default: m.Payouts })));
const Status = lazy(() => import('./pages/Status').then((m) => ({ default: m.Status })));
const AdminStatus = lazy(() =>
  import('./pages/AdminStatus').then((m) => ({ default: m.AdminStatus })),
);
const Feeds = lazy(() => import('./pages/Feeds').then((m) => ({ default: m.Feeds })));
const FeedView = lazy(() => import('./pages/FeedView').then((m) => ({ default: m.FeedView })));
const Discover = lazy(() => import('./pages/Discover').then((m) => ({ default: m.Discover })));
const Embed = lazy(() => import('./pages/Embed').then((m) => ({ default: m.Embed })));

function RouteFallback(): JSX.Element {
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
          spooool.com/studio* zone route — full page load, not client routing. */}
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
          void signOut().then(() => navigate('/', { replace: true }));
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
        navigate(`/search?q=${encodeURIComponent(q)}`);
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
  const stored = window.localStorage.getItem('theme');
  if (stored === 'light' || stored === 'dark') return stored;
  return window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light';
}

function ThemeToggle(): JSX.Element {
  const [theme, setTheme] = useState<Theme>(getInitialTheme);

  useEffect(() => {
    const root = document.documentElement;
    root.classList.toggle('dark', theme === 'dark');
    root.style.colorScheme = theme;
    window.localStorage.setItem('theme', theme);
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

function AppHeader(): JSX.Element {
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

const SUGGESTIONS: {
  title: string;
  helper: string;
  to: string;
  Icon: (props: { className?: string; style?: React.CSSProperties }) => JSX.Element;
}[] = [
  { title: 'Upload a clip', helper: 'Drop in an MP4, WebM, MOV, or MKV.', to: '/upload', Icon: UploadIcon },
  { title: 'Open a channel', helper: 'Visit a creator and skim their library.', to: '/channel/explore', Icon: ChannelIcon },
  { title: 'Watch something', helper: 'Jump into a video by id.', to: '/watch/demo', Icon: PlayIcon },
];

function TrendingCard({ video }: { video: TrendingVideo }): JSX.Element {
  return (
    <Link to={`/watch/${video.id}`} className="suggestion-card">
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
    <Link to={`/watch/${item.video_id}`} className="suggestion-card">
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

function Home(): JSX.Element {
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
      <section
        className="stack-sm"
        style={{
          alignItems: 'center',
          textAlign: 'center',
          paddingTop: 'var(--space-8)',
          paddingBottom: 'var(--space-4)',
        }}
      >
        <p className="ds-lede" style={{ maxWidth: 480, margin: '0 auto' }}>
          A video host that respects your time. Upload, stream, share — no friction.
        </p>
      </section>

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
              to={item.to}
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

function RequireAuth({ children }: { children: JSX.Element }): JSX.Element {
  const { data: session, isPending } = useSession();
  const location = useLocation();

  if (isPending) {
    return (
      <main className="app-main stack">
        <p className="ds-meta">Loading…</p>
      </main>
    );
  }

  if (!session) {
    return <Navigate to="/login" state={{ from: location.pathname }} replace />;
  }

  return children;
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

// The content hub (books/blogs/scripts + AI studio, ALO spec
// docs/superpowers/specs/studio-content-hub.md) is a separate worker mounted
// at spooool.com/studio via a zone route; a full page load hands the URL to
// it. The legacy AI Studio component remains for its panels to be absorbed
// into the hub. This component backs the in-shell `/studio` route as a
// belt-and-suspenders client redirect for the rare case the SPA serves
// `/studio` before the zone route intercepts it.
function StudioHubRedirect() {
  useEffect(() => {
    window.location.replace('/studio');
  }, []);
  return null;
}

// `App` is the default export mounted by main.tsx — the full spooool shell
// (header, routed pages, footer). The /studio handoff lives on its own route
// (StudioHubRedirect) and via the HeaderNav <a href="/studio"> hard link, so
// the rest of the app keeps client-side routing.
export default function App(): JSX.Element {
  const location = useLocation();
  const splash = useSplash();

  // Embed pages render as a bare player with no app shell so they can be
  // iframed into third-party sites without nav chrome. They still go through
  // React Router (so Embed's useParams() resolves :id) and MantineProvider,
  // but skip the header/nav/footer shell.
  if (location.pathname.startsWith('/embed/')) {
    return (
      <MantineProvider>
        <Suspense fallback={<div style={{ background: '#000', height: '100dvh' }} />}>
          <Routes>
            <Route path="/embed/:id" element={<Embed />} />
          </Routes>
        </Suspense>
      </MantineProvider>
    );
  }

  if (splash.show) {
    return <Splash onDone={splash.dismiss} />;
  }
  return (
    <MantineProvider>
    <div className="app-shell">
      <AppHeader />
      <Suspense fallback={<RouteFallback />}>
        <Routes>
          <Route path="/" element={<Home />} />
          <Route path="/login" element={<Login />} />
          <Route path="/signup" element={<Signup />} />
          <Route path="/forgot-password" element={<ForgotPassword />} />
          <Route path="/reset-password" element={<ResetPassword />} />
          <Route path="/watch/:id" element={<Watch />} />
          <Route
            path="/upload"
            element={
              <RequireAuth>
                <Upload />
              </RequireAuth>
            }
          />
          <Route
            path="/record"
            element={
              <RequireAuth>
                <Record />
              </RequireAuth>
            }
          />
          <Route
            path="/create"
            element={
              <RequireAuth>
                <Create />
              </RequireAuth>
            }
          />
          <Route path="/studio" element={<StudioHubRedirect />} />
          <Route
            path="/profile"
            element={
              <RequireAuth>
                <Profile />
              </RequireAuth>
            }
          />
          <Route path="/channel/:username" element={<Channel />} />
          <Route path="/search" element={<Search />} />
          <Route path="/tag/:slug" element={<Tag />} />
          <Route
            path="/admin/moderation"
            element={
              <RequireAuth>
                <AdminModeration />
              </RequireAuth>
            }
          />
          <Route
            path="/admin/roles"
            element={
              <RequireAuth>
                <AdminRoles />
              </RequireAuth>
            }
          />
          <Route path="/settings" element={<Navigate to="/settings/account" replace />} />
          <Route
            path="/settings/account"
            element={
              <RequireAuth>
                <AccountSettings />
              </RequireAuth>
            }
          />
          <Route path="/legal/dmca" element={<DmcaForm />} />
          <Route
            path="/legal/dmca/counter"
            element={
              <RequireAuth>
                <DmcaCounter />
              </RequireAuth>
            }
          />
          <Route path="/dmca-notice/:videoId" element={<DmcaNotice />} />
          <Route path="/legal/tos" element={<Tos />} />
          <Route path="/legal/privacy" element={<Privacy />} />
          <Route path="/pricing" element={<Pricing />} />
          <Route
            path="/subscriptions"
            element={
              <RequireAuth>
                <Subscriptions />
              </RequireAuth>
            }
          />
          <Route
            path="/feeds"
            element={
              <RequireAuth>
                <Feeds />
              </RequireAuth>
            }
          />
          <Route path="/feeds/:id" element={<FeedView />} />
          <Route
            path="/discover"
            element={
              <RequireAuth>
                <Discover />
              </RequireAuth>
            }
          />
          <Route
            path="/onboarding"
            element={
              <RequireAuth>
                <Onboarding />
              </RequireAuth>
            }
          />
          <Route
            path="/payouts"
            element={
              <RequireAuth>
                <Payouts />
              </RequireAuth>
            }
          />
          <Route path="/status" element={<Status />} />
          <Route
            path="/admin/status"
            element={
              <RequireAuth>
                <AdminStatus />
              </RequireAuth>
            }
          />
          <Route path="*" element={<NotFound />} />
        </Routes>
      </Suspense>
      <SiteFooter />
    </div>
    </MantineProvider>
  );
}
