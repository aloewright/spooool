// Project workspace shell — ported from
// studio/apps/web/client/routes/_hub.$projectId.tsx.
//
// In the studio source this file was a layout route that (a) validated the
// ?logline search param and (b) redirected the bare /$projectId to
// /$projectId/canvas via beforeLoad, then rendered <Outlet/>. In spooool's
// code-based router those two responsibilities are split:
//   - validateSearch (passthroughSearch) is declared on the route in router.tsx.
//   - The bare-path → /canvas redirect is the $projectId index child route in
//     router.tsx (a <Navigate to="/studio/$projectId/canvas">).
// So this component is just the layout <Outlet/>; the child canvas/outline
// screens render through it.
import type { JSX } from 'react';
import { Outlet } from '@tanstack/react-router';

export function ProjectShell(): JSX.Element {
  return <Outlet />;
}
