// Blog workspace layout shell — the /studio/blogs/$blogId nested LAYOUT route.
//
// Mirrors ProjectShell: in the studio source the blog routes were sibling file
// routes (_hub.blogs.$blogId.index / .structure) with no wrapping layout. In
// spooool's code-based router we register /studio/blogs/$blogId as a nested
// parent route whose index + structure children render through this <Outlet/>,
// matching how $projectId is structured. The visual chrome (BlogShell: drawer +
// breadcrumb) lives in each child screen, not here — so this layout is just the
// passthrough <Outlet/>. validateSearch (passthroughSearch) is declared on the
// route in router.tsx.
import type { JSX } from 'react';
import { Outlet } from '@tanstack/react-router';

export function BlogShellRoute(): JSX.Element {
  return <Outlet />;
}
