// Full manuscript view + export — ported from
// studio/apps/web/client/routes/_hub.$projectId.book.tsx.
//
// Changes vs the studio source:
//   - File route (createFileRoute("/_hub/$projectId/book")) → plain component
//     (ProjectBook), mounted by spooool's code-based router at
//     /studio/$projectId/book (router.tsx).
//   - Params read via useParams({ strict: false }) (the spooool convention for
//     code-based routes; see ProjectCanvas/ProjectOutline).
//   - Component imports point at the ported copies under ../components and ../lib.
//
// The export actions inside FullBookPanel invoke the deferred book-export
// workflow; that panel surfaces the backend's "unavailable" error inline (see
// FullBookPanel) rather than crashing.
import type { JSX } from 'react';
import { useQuery } from '@tanstack/react-query';
import { useParams } from '@tanstack/react-router';
import FullBookPanel from '../components/panels/FullBookPanel';
import { BreadcrumbPill } from '../components/studio/BreadcrumbPill';
import { SideDrawer } from '../components/studio/SideDrawer';
import { TopLeftPill } from '../components/studio/TopLeftPill';
import { api, queryKeys } from '../lib/api';
import { useDrawerLayout } from '../lib/drawer-layout';

export function ProjectBook(): JSX.Element {
  const { projectId = '' } = useParams({ strict: false });
  const project = useQuery({
    queryKey: queryKeys.project(projectId),
    queryFn: () => api.getProject(projectId),
  });
  const drawer = useDrawerLayout();
  const title = project.data?.title ?? 'Untitled book';

  return (
    <div className="relative min-h-screen bg-[#efece2] text-neutral-900 dark:bg-[#1a1a1a] dark:text-neutral-100">
      <SideDrawer projectId={projectId} current="book" />
      <TopLeftPill />
      <BreadcrumbPill title={title} />
      <main
        className={`px-6 pt-28 pb-20 transition-[padding] ${
          drawer.open ? (drawer.collapsed ? 'lg:pl-[5rem]' : 'lg:pl-[19rem]') : ''
        }`}
      >
        <section className="mx-auto flex max-w-7xl flex-col gap-6 pb-8">
          <FullBookPanel projectId={projectId} />
        </section>
      </main>
    </div>
  );
}
