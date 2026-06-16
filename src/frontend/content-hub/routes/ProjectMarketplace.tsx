// Marketplace workspace (Scout / Launch / Publish tabs) — ported from
// studio/apps/web/client/routes/_hub.$projectId.marketplace.tsx.
//
// Changes vs the studio source:
//   - File route (createFileRoute("/_hub/$projectId/marketplace")) → plain
//     component (ProjectMarketplace), mounted by spooool's code-based router at
//     /studio/$projectId/marketplace (router.tsx).
//   - The studio route declared validateSearch for the ?tab param. In spooool's
//     code-based router search validation is passthroughSearch on the route
//     (router.tsx); the tab is read here via useSearch({ strict: false }) and
//     normalized with isTab(), matching how ProjectCanvas/ProjectOutline read
//     ?logline.
//   - Tab switching navigates via useNavigate to the spooool-absolute typed
//     route /studio/$projectId/marketplace.
//   - Component imports point at the ported copies under ../components and ../lib.
//
// The panels mounted here invoke deferred actions (LaunchPanel's gtm-brief,
// PublishPanel's export / narration / audiobook workflows); each panel surfaces
// the backend's "unavailable" error inline rather than crashing.
import type { JSX } from 'react';
import { useQuery } from '@tanstack/react-query';
import { useNavigate, useParams, useSearch } from '@tanstack/react-router';
import ConceptScoutPanel from '../components/panels/ConceptScoutPanel';
import LaunchPanel from '../components/panels/LaunchPanel';
import PublishPanel from '../components/panels/PublishPanel';
import { BreadcrumbPill } from '../components/studio/BreadcrumbPill';
import { SideDrawer } from '../components/studio/SideDrawer';
import { TopLeftPill } from '../components/studio/TopLeftPill';
import { api, queryKeys } from '../lib/api';
import { useDrawerLayout } from '../lib/drawer-layout';

type MarketplaceTab = 'scout' | 'launch' | 'publish';

const TABS: { id: MarketplaceTab; label: string }[] = [
  { id: 'scout', label: 'Scout' },
  { id: 'launch', label: 'Launch' },
  { id: 'publish', label: 'Publish' },
];

function isTab(v: unknown): v is MarketplaceTab {
  return v === 'scout' || v === 'launch' || v === 'publish';
}

export function ProjectMarketplace(): JSX.Element {
  const { projectId = '' } = useParams({ strict: false });
  const search = useSearch({ strict: false }) as { tab?: unknown };
  const nav = useNavigate();
  const active: MarketplaceTab = isTab(search.tab) ? search.tab : 'scout';

  const project = useQuery({
    queryKey: queryKeys.project(projectId),
    queryFn: () => api.getProject(projectId),
  });
  const drawer = useDrawerLayout();
  const title = project.data?.title ?? 'Untitled book';

  return (
    <div className="relative min-h-screen bg-[#efece2] text-neutral-900 dark:bg-[#1a1a1a] dark:text-neutral-100">
      <SideDrawer projectId={projectId} current="marketplace" />
      <TopLeftPill />
      <BreadcrumbPill title={title} />

      <main
        className={`px-6 pt-28 pb-20 transition-[padding] ${
          drawer.open ? (drawer.collapsed ? 'lg:pl-[5rem]' : 'lg:pl-[19rem]') : ''
        }`}
      >
        <div className="mx-auto max-w-6xl">
          <div className="mb-6 inline-flex items-center gap-1 rounded-full bg-neutral-950/90 p-1 text-neutral-200 text-sm shadow-lg ring-1 ring-white/5 backdrop-blur">
            {TABS.map((t) => (
              <button
                key={t.id}
                className={`rounded-full px-4 py-1.5 transition ${
                  active === t.id ? 'bg-white/15 text-white' : 'hover:bg-white/10'
                }`}
                onClick={() =>
                  nav({
                    to: '/studio/$projectId/marketplace',
                    params: { projectId },
                    search: { tab: t.id },
                  })
                }
                type="button"
              >
                {t.label}
              </button>
            ))}
          </div>

          {project.data ? (
            active === 'scout' ? (
              <ConceptScoutPanel project={project.data} />
            ) : active === 'launch' ? (
              <LaunchPanel projectId={projectId} />
            ) : (
              <PublishPanel project={project.data} />
            )
          ) : (
            <p className="font-serif text-neutral-500 text-sm">Loading…</p>
          )}
        </div>
      </main>
    </div>
  );
}
