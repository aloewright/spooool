// Test helpers for mounting components under @tanstack/react-router (phase 3b
// router migration). Replaces the old <MemoryRouter> in *.dom.test
// files.
//
// Two helpers:
//   - renderWithRouter(element): wraps a component in a minimal in-memory
//     TanStack router so hooks like useParams/useSearch/Link work. The
//     component is rendered as the index route's content. Use for component
//     unit tests that just need a router context.
//   - createComponentRouter({ element, path, initialEntries }): build a router
//     that mounts `element` at a parameterized `path` (e.g. '/feeds/$id'),
//     navigated to `initialEntries[0]` (e.g. '/feeds/f1') — for tests that
//     assert on path params.
import { useState, type JSX, type ReactNode } from 'react';
import {
  createMemoryHistory,
  createRootRoute,
  createRoute,
  createRouter,
  Outlet,
  RouterProvider,
} from '@tanstack/react-router';
import { routeTree } from '../router';

type AnyRouter = ReturnType<typeof createRouter>;

/**
 * Build a router over the REAL app route tree (router.tsx) navigated to
 * `route`, using in-memory history. Used by App.shell / App.studio dom tests
 * that mount the full route tree at a specific path and assert footer /
 * headings / redirects.
 */
export function createRealRouter(route: string): AnyRouter {
  return createRouter({
    routeTree,
    history: createMemoryHistory({ initialEntries: [route] }),
  }) as AnyRouter;
}

/** JSX wrapper that mounts the real app route tree at `route`. */
export function RealAppAt({ route }: { route: string }): JSX.Element {
  // Create the router once (see RouterHarness note) — rebuilding it per render
  // re-commits the location every render and loops.
  const [router] = useState(() => createRealRouter(route));
  return <RouterProvider router={router} />;
}

/**
 * Build a TanStack router that renders `element` at `path`, starting at
 * `initialEntries[0]`. The root renders an <Outlet/>; the single child route
 * at `path` renders `element` (with passthrough search validation so any
 * query params are allowed).
 */
export function createComponentRouter({
  element,
  path,
  initialEntries = ['/'],
}: {
  element: ReactNode;
  path?: string;
  initialEntries?: string[];
}): AnyRouter {
  const rootRoute = createRootRoute({ component: () => <Outlet /> });
  // When an explicit `path` is given (e.g. '/feeds/$id'), mount `element` there
  // so path params resolve. Otherwise mount it at a splat route that matches
  // ANY path — this mirrors react-router's <MemoryRouter> rendering its
  // children regardless of the current location, so component unit tests can
  // pass arbitrary `initialEntries` (e.g. '/watch/abc') and still render.
  const route = path
    ? createRoute({
        getParentRoute: () => rootRoute,
        path,
        validateSearch: (s: Record<string, unknown>) => s,
        component: () => <>{element}</>,
      })
    : createRoute({
        getParentRoute: () => rootRoute,
        path: '$',
        validateSearch: (s: Record<string, unknown>) => s,
        component: () => <>{element}</>,
      });
  const routeTree = rootRoute.addChildren([route]);
  return createRouter({
    routeTree,
    history: createMemoryHistory({ initialEntries }),
    defaultNotFoundComponent: () => null,
  }) as AnyRouter;
}

/**
 * Convenience JSX wrapper mirroring `<MemoryRouter>{element}</MemoryRouter>`.
 * Renders `element` at the index route of an in-memory router.
 */
export function RouterHarness({
  element,
  path,
  initialEntries,
}: {
  element: ReactNode;
  path?: string;
  initialEntries?: string[];
}): JSX.Element {
  // Create the router exactly once. Building it inside the render body would
  // hand RouterProvider a new instance on every re-render, which re-commits
  // the location each render → infinite update loop.
  const [router] = useState(() =>
    createComponentRouter({ element, path, initialEntries }),
  );
  return <RouterProvider router={router} />;
}

/**
 * Drop-in replacement for the old `<MemoryRouter>` in tests. Wraps
 * its children in an in-memory TanStack router so router hooks/Link resolve.
 * Lets existing `<MemoryRouter>{children}</MemoryRouter>` call sites migrate by
 * swapping only the import.
 */
export function MemoryRouter({
  children,
  initialEntries,
}: {
  children: ReactNode;
  initialEntries?: string[];
}): JSX.Element {
  return <RouterHarness element={children} initialEntries={initialEntries} />;
}
