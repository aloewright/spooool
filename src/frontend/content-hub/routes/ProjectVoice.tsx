// Narration / author-voice library — ported from
// studio/apps/web/client/routes/_hub.$projectId.voice.tsx.
//
// Changes vs the studio source:
//   - File route (createFileRoute("/_hub/$projectId/voice")) → plain component
//     (ProjectVoice), mounted by spooool's code-based router at
//     /studio/$projectId/voice (router.tsx).
//   - Params read via useParams({ strict: false }).
//   - Component imports point at the ported copies under ../components and ../lib.
//
// VoicePanel's actions all hit live, non-deferred endpoints; no workflow
// bindings are involved here.
import type { JSX } from 'react';
import { useQuery } from '@tanstack/react-query';
import { useParams } from '@tanstack/react-router';
import VoicePanel from '../components/panels/VoicePanel';
import { BreadcrumbPill } from '../components/studio/BreadcrumbPill';
import { SideDrawer } from '../components/studio/SideDrawer';
import { TopLeftPill } from '../components/studio/TopLeftPill';
import { api, queryKeys } from '../lib/api';
import { useDrawerLayout } from '../lib/drawer-layout';

export function ProjectVoice(): JSX.Element {
  const { projectId = '' } = useParams({ strict: false });
  const project = useQuery({
    queryKey: queryKeys.project(projectId),
    queryFn: () => api.getProject(projectId),
  });
  const drawer = useDrawerLayout();
  const title = project.data?.title ?? 'Untitled book';

  return (
    <div className="relative min-h-screen bg-[#efece2] text-neutral-900 dark:bg-[#1a1a1a] dark:text-neutral-100">
      <SideDrawer projectId={projectId} current="voice" />
      <TopLeftPill />
      <BreadcrumbPill title={title} />

      <main
        className={`px-6 pt-28 pb-20 transition-[padding] ${
          drawer.open ? (drawer.collapsed ? 'lg:pl-[5rem]' : 'lg:pl-[19rem]') : ''
        }`}
      >
        <div className="mx-auto max-w-5xl">
          {project.data ? (
            <VoicePanel project={project.data} />
          ) : (
            <p className="font-serif text-neutral-500 text-sm">Loading voice library…</p>
          )}
        </div>
      </main>
    </div>
  );
}
