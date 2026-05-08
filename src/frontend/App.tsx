import { lazy, Suspense, useEffect, useState } from 'react';
import { Link, Navigate, Route, Routes, useLocation, useNavigate, useSearchParams } from 'react-router-dom';
import { signOut, useSession } from './lib/auth-client';
import { ChannelIcon, PlayIcon, UploadIcon, VideoPlaceholderIcon } from './components/Icons';
import './styles/strand.css';

// Route-level code splitting: each page (and the hls.js it depends on for
// /watch) is fetched only when navigated to. Cuts the initial JS payload on
// the home route from ~275KB gz to the React-vendor + Home shell. See ALO-199
// (and ALO-204 for the video.js → hls.js swap that took the watch chunk from
// ~570KB raw to ~150KB raw).
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
const CreatorPayouts = lazy(() =>
  import('./pages/CreatorPayouts').then((m) => ({ default: m.CreatorPayouts })),
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

function Wordmark({ size = 'lg' }: { size?: 'lg' | 'sm' }): JSX.Element {
  return (
    <Link to="/" aria-label="spooool" className={size === 'sm' ? 'ds-wordmark ds-wordmark--sm' : 'ds-wordmark'}>
      spooool
    </Link>
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

  return (
    <nav className="app-header__nav">
      <span className="ds-meta">{session.user.email}</span>
      <Link to="/upload">
        <button type="button" className="btn btn--secondary btn--sm">Upload</button>
      </Link>
      <Link to="/profile">
        <button type="button" className="btn btn--ghost btn--sm">Profile</button>
      </Link>
      <button
        type="button"
        className="btn btn--ghost btn--sm"
        onClick={() => {
          // ALO-166: tear down the PostHog identity before navigating so
          // the next visitor on a shared device starts a fresh session.
          void import('./lib/analytics').then(({ reset }) => reset());
          void signOut().then(() => navigate('/', { replace: true }));
        }}
      >
        Sign out
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

  return (
    <button
      type="button"
      className="btn btn--ghost btn--sm"
      aria-label={`Switch to ${theme === 'dark' ? 'light' : 'dark'} mode`}
      title={`Switch to ${theme === 'dark' ? 'light' : 'dark'} mode`}
      onClick={() => setTheme((t) => (t === 'dark' ? 'light' : 'dark'))}
    >
      <span aria-hidden="true" style={{ fontSize: 16, lineHeight: 1 }}>
        {theme === 'dark' ? '🌞' : '🌙'}
      </span>
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
    <>
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
        <Wordmark />
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

      <section className="stack-sm" aria-label="Get started">
        <h2 className="ds-h3" style={{ margin: 0 }}>Start here</h2>
        <div
          style={{
            display: 'grid',
            gridTemplateColumns: 'repeat(auto-fit, minmax(220px, 1fr))',
            gap: 'var(--space-3)',
          }}
        >
          {SUGGESTIONS.map((item) => (
            <Link key={item.title} to={item.to} className="suggestion-card">
              <div
                style={{
                  display: 'flex',
                  alignItems: 'center',
                  justifyContent: 'center',
                  width: 44,
                  height: 44,
                  borderRadius: 10,
                  marginBottom: 'var(--space-2)',
                  background: 'color-mix(in oklch, var(--accent), transparent 85%)',
                  color: 'var(--accent)',
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
      <Link to="/legal/dmca">DMCA</Link>
    </footer>
    </>
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

export default function App(): JSX.Element {
  return (
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
          <Route
            path="/creator/payouts"
            element={
              <RequireAuth>
                <CreatorPayouts />
              </RequireAuth>
            }
          />
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
          <Route path="*" element={<Navigate to="/" replace />} />
        </Routes>
      </Suspense>
    </div>
  );
}
