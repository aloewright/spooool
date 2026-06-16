// Script workspace layout shell — the /studio/scripts/$scriptId nested LAYOUT
// route.
//
// Mirrors ProjectShell / BlogShellRoute: in the studio source the script routes
// were sibling file routes (_hub.scripts.$scriptId.index / .structure) with no
// wrapping layout. In spooool's code-based router we register
// /studio/scripts/$scriptId as a nested parent route whose index + structure
// children render through this <Outlet/>. The visual chrome (ScriptShell:
// drawer + breadcrumb) lives in each child screen, not here — so this layout is
// just the passthrough <Outlet/>. validateSearch (passthroughSearch) is
// declared on the route in router.tsx.
import type { JSX } from 'react';
import { Outlet } from '@tanstack/react-router';

export function ScriptShellRoute(): JSX.Element {
  return <Outlet />;
}
