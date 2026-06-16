import { lazy, Suspense, useMemo, type JSX } from 'react';
import {
  createRootRoute,
  createRoute,
  createRouter,
  Navigate,
  Outlet,
  useLocation,
} from '@tanstack/react-router';
import { MantineProvider } from '@mantine/core';
import '@mantine/core/styles.css';
import { useSession } from './lib/auth-client';
// App.tsx holds the eager shell (header/footer/splash/Home + StudioHub) and is
// always in the initial chunk, so Home is imported statically here — lazy()ing
// it from the same module would be a no-op split (rolldown warns).
import { AppHeader, Home, RouteFallback, SiteFooter, SplashGate, StudioHub } from './App';
import { CookieBanner } from './components/CookieBanner';
import './styles/strand.css';

// Route-level code splitting: each page (and the @cloudflare/stream-react
// SDK loader the /watch chunk depends on) is fetched only when navigated to.
// Cuts the initial JS payload on the home route to the React-vendor + Home
// shell. Preserved verbatim from the react-router v6 era — TanStack Router
// renders these lazy components under <Suspense> exactly the same way.
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
const Studio = lazy(() => import('./pages/Studio').then((m) => ({ default: m.Studio })));
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
const Waitlist = lazy(() => import('./pages/Waitlist').then((m) => ({ default: m.Waitlist })));

// Render-guard auth gate, preserved from the react-router v6 era (ALO phase
// 3b: intentionally NOT switched to beforeLoad to minimize behavior change).
// TanStack has no router-location `state`, so the post-login redirect target
// is carried as a `?from=` search param instead; the Login/Signup pages read
// it back from search. See useSearchParams compat shim + Login.tsx.
function RequireAuth({ children }: { children: JSX.Element }): JSX.Element {
  const { data: session, isPending } = useSession();
  const location = useLocation();

  // TanStack's <Navigate> re-fires whenever its props object identity changes
  // (it compares previousProps !== props in a layout effect). A component that
  // also subscribes to router/session state re-renders, producing a fresh JSX
  // element (new props object) each time → infinite navigate loop. Memoize the
  // whole <Navigate> element so it fires once (matching react-router's
  // mount-only redirect).
  const loginRedirect = useMemo(
    () => <Navigate to="/login" search={{ from: location.pathname }} replace />,
    [location.pathname],
  );

  if (isPending) {
    return (
      <main className="app-main stack">
        <p className="ds-meta">Loading…</p>
      </main>
    );
  }

  if (!session) {
    return loginRedirect;
  }

  return children;
}

// Passthrough search validation. Lets arbitrary query params survive a round
// trip through the router without a per-route typed-search schema, which is
// what the useSearchParams compat shim relies on.
const passthroughSearch = (s: Record<string, unknown>): Record<string, unknown> => s;

// ── Root: provides MantineProvider for the whole tree, renders the matched
// route via <Outlet/>. Embed sits directly under root (bare, no shell); all
// other routes sit under the `shellRoute` pathless layout which adds the
// header/footer/splash chrome.
const rootRoute = createRootRoute({
  component: function RootComponent(): JSX.Element {
    return (
      <MantineProvider>
        <Outlet />
      </MantineProvider>
    );
  },
  notFoundComponent: function NotFoundComponent(): JSX.Element {
    // Catch-all 404 still renders inside the shell (header + footer), matching
    // the old `<Route path="*">` behavior under the app shell.
    return (
      <SplashGate>
        <div className="app-shell">
          <AppHeader />
          <Suspense fallback={<RouteFallback />}>
            <NotFound />
          </Suspense>
          <SiteFooter />
          <CookieBanner />
        </div>
      </SplashGate>
    );
  },
});

// ── Bare embed route (sibling of the shell): no header/nav/footer chrome so
// it can be iframed into third-party sites. Still goes through the router (so
// Embed's useParams resolves $id) and MantineProvider (from root).
const embedRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: '/embed/$id',
  component: function EmbedRoute(): JSX.Element {
    return (
      <Suspense fallback={<div style={{ background: '#000', height: '100dvh' }} />}>
        <Embed />
      </Suspense>
    );
  },
});

// ── Pathless layout route: renders the full app shell (splash gate + header +
// <Outlet/> + footer + cookie banner). Every shelled route is a child of this.
const shellRoute = createRoute({
  getParentRoute: () => rootRoute,
  id: 'shell',
  component: function ShellLayout(): JSX.Element {
    return (
      <SplashGate>
        <div className="app-shell">
          <AppHeader />
          <Suspense fallback={<RouteFallback />}>
            <Outlet />
          </Suspense>
          <SiteFooter />
          <CookieBanner />
        </div>
      </SplashGate>
    );
  },
});

// Shelled routes are inlined `createRoute({ getParentRoute: () => shellRoute })`
// calls (NOT wrapped in a helper) so TanStack can statically infer each
// route's full path into the typed `Register` route tree — a helper collapses
// the per-route path types and breaks `<Link to>` / navigate type-safety.
// `validateSearch: passthroughSearch` is added on routes whose pages read
// query params via the useSearchParams compat shim.
const indexRoute = createRoute({
  getParentRoute: () => shellRoute,
  path: '/',
  component: () => <Home />,
});
const loginRoute = createRoute({
  getParentRoute: () => shellRoute,
  path: '/login',
  validateSearch: passthroughSearch,
  component: () => <Login />,
});
const signupRoute = createRoute({
  getParentRoute: () => shellRoute,
  path: '/signup',
  validateSearch: passthroughSearch,
  component: () => <Signup />,
});
const forgotPasswordRoute = createRoute({
  getParentRoute: () => shellRoute,
  path: '/forgot-password',
  component: () => <ForgotPassword />,
});
const resetPasswordRoute = createRoute({
  getParentRoute: () => shellRoute,
  path: '/reset-password',
  validateSearch: passthroughSearch,
  component: () => <ResetPassword />,
});
const watchRoute = createRoute({
  getParentRoute: () => shellRoute,
  path: '/watch/$id',
  validateSearch: passthroughSearch,
  component: () => <Watch />,
});
const uploadRoute = createRoute({
  getParentRoute: () => shellRoute,
  path: '/upload',
  component: () => (
    <RequireAuth>
      <Upload />
    </RequireAuth>
  ),
});
const recordRoute = createRoute({
  getParentRoute: () => shellRoute,
  path: '/record',
  component: () => (
    <RequireAuth>
      <Record />
    </RequireAuth>
  ),
});
const createRouteRoute = createRoute({
  getParentRoute: () => shellRoute,
  path: '/create',
  validateSearch: passthroughSearch,
  component: () => (
    <RequireAuth>
      <Create />
    </RequireAuth>
  ),
});
const studioRoute = createRoute({
  getParentRoute: () => shellRoute,
  path: '/studio',
  validateSearch: passthroughSearch,
  component: () => <StudioHub />,
});
// Legacy base path: /words* → /studio (matches the old zone-route 301).
const wordsRoute = createRoute({
  getParentRoute: () => shellRoute,
  path: '/words',
  component: () => <Navigate to="/studio" replace />,
});
const wordsSplatRoute = createRoute({
  getParentRoute: () => shellRoute,
  path: '/words/$',
  component: () => <Navigate to="/studio" replace />,
});
const profileRoute = createRoute({
  getParentRoute: () => shellRoute,
  path: '/profile',
  component: () => (
    <RequireAuth>
      <Profile />
    </RequireAuth>
  ),
});
const channelRoute = createRoute({
  getParentRoute: () => shellRoute,
  path: '/channel/$username',
  component: () => <Channel />,
});
const searchRoute = createRoute({
  getParentRoute: () => shellRoute,
  path: '/search',
  validateSearch: passthroughSearch,
  component: () => <Search />,
});
const tagRoute = createRoute({
  getParentRoute: () => shellRoute,
  path: '/tag/$slug',
  component: () => <Tag />,
});
const adminModerationRoute = createRoute({
  getParentRoute: () => shellRoute,
  path: '/admin/moderation',
  component: () => (
    <RequireAuth>
      <AdminModeration />
    </RequireAuth>
  ),
});
const adminRolesRoute = createRoute({
  getParentRoute: () => shellRoute,
  path: '/admin/roles',
  component: () => (
    <RequireAuth>
      <AdminRoles />
    </RequireAuth>
  ),
});
const settingsRoute = createRoute({
  getParentRoute: () => shellRoute,
  path: '/settings',
  component: () => <Navigate to="/settings/account" replace />,
});
const accountSettingsRoute = createRoute({
  getParentRoute: () => shellRoute,
  path: '/settings/account',
  validateSearch: passthroughSearch,
  component: () => (
    <RequireAuth>
      <AccountSettings />
    </RequireAuth>
  ),
});
const dmcaFormRoute = createRoute({
  getParentRoute: () => shellRoute,
  path: '/legal/dmca',
  component: () => <DmcaForm />,
});
const dmcaCounterRoute = createRoute({
  getParentRoute: () => shellRoute,
  path: '/legal/dmca/counter',
  component: () => (
    <RequireAuth>
      <DmcaCounter />
    </RequireAuth>
  ),
});
const dmcaNoticeRoute = createRoute({
  getParentRoute: () => shellRoute,
  path: '/dmca-notice/$videoId',
  component: () => <DmcaNotice />,
});
const tosRoute = createRoute({
  getParentRoute: () => shellRoute,
  path: '/legal/tos',
  component: () => <Tos />,
});
const privacyRoute = createRoute({
  getParentRoute: () => shellRoute,
  path: '/legal/privacy',
  component: () => <Privacy />,
});
const pricingRoute = createRoute({
  getParentRoute: () => shellRoute,
  path: '/pricing',
  component: () => <Pricing />,
});
const subscriptionsRoute = createRoute({
  getParentRoute: () => shellRoute,
  path: '/subscriptions',
  component: () => (
    <RequireAuth>
      <Subscriptions />
    </RequireAuth>
  ),
});
const feedsRoute = createRoute({
  getParentRoute: () => shellRoute,
  path: '/feeds',
  component: () => (
    <RequireAuth>
      <Feeds />
    </RequireAuth>
  ),
});
const feedViewRoute = createRoute({
  getParentRoute: () => shellRoute,
  path: '/feeds/$id',
  component: () => <FeedView />,
});
const discoverRoute = createRoute({
  getParentRoute: () => shellRoute,
  path: '/discover',
  component: () => (
    <RequireAuth>
      <Discover />
    </RequireAuth>
  ),
});
const onboardingRoute = createRoute({
  getParentRoute: () => shellRoute,
  path: '/onboarding',
  component: () => (
    <RequireAuth>
      <Onboarding />
    </RequireAuth>
  ),
});
const payoutsRoute = createRoute({
  getParentRoute: () => shellRoute,
  path: '/payouts',
  component: () => (
    <RequireAuth>
      <Payouts />
    </RequireAuth>
  ),
});
const statusRoute = createRoute({
  getParentRoute: () => shellRoute,
  path: '/status',
  component: () => <Status />,
});
const adminStatusRoute = createRoute({
  getParentRoute: () => shellRoute,
  path: '/admin/status',
  component: () => (
    <RequireAuth>
      <AdminStatus />
    </RequireAuth>
  ),
});
const waitlistRoute = createRoute({
  getParentRoute: () => shellRoute,
  path: '/waitlist',
  component: () => <Waitlist />,
});

const shellRouteTree = shellRoute.addChildren([
  indexRoute,
  loginRoute,
  signupRoute,
  forgotPasswordRoute,
  resetPasswordRoute,
  watchRoute,
  uploadRoute,
  recordRoute,
  createRouteRoute,
  studioRoute,
  wordsRoute,
  wordsSplatRoute,
  profileRoute,
  channelRoute,
  searchRoute,
  tagRoute,
  adminModerationRoute,
  adminRolesRoute,
  settingsRoute,
  accountSettingsRoute,
  dmcaFormRoute,
  dmcaCounterRoute,
  dmcaNoticeRoute,
  tosRoute,
  privacyRoute,
  pricingRoute,
  subscriptionsRoute,
  feedsRoute,
  feedViewRoute,
  discoverRoute,
  onboardingRoute,
  payoutsRoute,
  statusRoute,
  adminStatusRoute,
  waitlistRoute,
]);

// Exported so tests can build a fresh memory-history router over the exact
// same route tree the app ships (App.shell / App.studio dom tests mount the
// real tree at specific paths).
export const routeTree = rootRoute.addChildren([embedRoute, shellRouteTree]);

export const router = createRouter({
  routeTree,
  defaultPreload: 'intent',
});

declare module '@tanstack/react-router' {
  interface Register {
    router: typeof router;
  }
}
