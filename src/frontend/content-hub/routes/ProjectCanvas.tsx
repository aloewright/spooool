// Read-only chapter/scene canvas — ported from
// studio/apps/web/client/routes/_hub.$projectId.canvas.tsx.
//
// Changes vs the studio source:
//   - File route (createFileRoute("/_hub/$projectId/canvas")) → plain component
//     (ProjectCanvas), mounted by spooool's code-based router at
//     /studio/$projectId/canvas (router.tsx).
//   - Params/search read via useParams/useSearch({ strict: false }) instead of
//     Route.useParams()/Route.useSearch() (the spooool convention for
//     code-based routes; see Watch.tsx / FeedView.tsx).
//   - In-app links are /studio-absolute. The outline link is a typed <Link>
//     (that route is registered in this PR). The chapter-editor link
//     (/studio/$projectId/chapters/$chapterId) is PR-4 and not in the typed
//     route tree yet, so the canvas's only chapter target — the outline — is
//     used; there are no chapter-editor links in this screen.
//   - Component imports point at the ported copies under ../components/studio
//     and ../lib.
import { useQuery } from '@tanstack/react-query';
import { Link, useParams, useSearch } from '@tanstack/react-router';
import { BreadcrumbPill } from '../components/studio/BreadcrumbPill';
import { SideDrawer } from '../components/studio/SideDrawer';
import { TopLeftPill } from '../components/studio/TopLeftPill';
import { SceneCard } from '../components/studio/scene-bits';
import { type Chapter, api, queryKeys } from '../lib/api';
import { useDrawerLayout } from '../lib/drawer-layout';

export function ProjectCanvas() {
  const { projectId = '' } = useParams({ strict: false });
  const search = useSearch({ strict: false }) as { logline?: string };
  const logline = typeof search.logline === 'string' ? search.logline : undefined;
  const drawer = useDrawerLayout();

  const project = useQuery({
    queryKey: queryKeys.project(projectId),
    queryFn: () => api.getProject(projectId),
  });
  const outline = useQuery({
    queryKey: queryKeys.projectOutline(projectId),
    queryFn: () => api.getProjectOutline(projectId),
  });

  const chapters = outline.data?.chapters ?? [];
  const title = project.data?.title ?? 'Untitled book';

  return (
    <div className="relative min-h-screen bg-[#efece2] text-neutral-900 dark:bg-[#1a1a1a] dark:text-neutral-100">
      <SideDrawer projectId={projectId} current="outline" />
      <TopLeftPill />
      <BreadcrumbPill title={title} />

      <main
        className={`flex flex-col items-center gap-6 px-6 pt-28 pb-40 transition-[padding] ${
          drawer.open ? (drawer.collapsed ? 'lg:pl-[5rem]' : 'lg:pl-[19rem]') : ''
        } ${drawer.chatOpen ? 'lg:pr-[19rem]' : 'lg:pr-[5rem]'}`}
      >
        {logline && (
          <div className="w-full max-w-3xl">
            <div className="rounded-2xl bg-neutral-950/90 px-5 py-3 text-neutral-200 ring-1 ring-white/5">
              <div className="text-[11px] text-neutral-400 uppercase tracking-wide">Logline</div>
              <p className="mt-1 font-serif text-[15px] leading-relaxed">{logline}</p>
            </div>
          </div>
        )}

        {outline.isLoading && (
          <p className="font-serif text-neutral-500 text-sm">Loading canvas…</p>
        )}

        {!outline.isLoading && chapters.length === 0 && (
          <div className="flex w-full max-w-3xl flex-col items-center gap-4 rounded-2xl bg-white/50 py-16 text-center ring-1 ring-black/5 dark:bg-neutral-900/50 dark:ring-white/5">
            <p className="font-serif text-neutral-500 dark:text-neutral-400">
              No chapters yet. Generate an outline to get started.
            </p>
            <Link
              className="rounded-full bg-neutral-950/90 px-4 py-2 text-sm text-neutral-200 transition hover:bg-neutral-800"
              params={{ projectId }}
              to="/studio/$projectId/outline"
            >
              Generate outline
            </Link>
          </div>
        )}

        {chapters.map((chapter) => (
          <ChapterSection key={chapter.id} chapter={chapter} projectId={projectId} />
        ))}
      </main>
    </div>
  );
}

function ChapterSection({
  chapter,
  projectId,
}: {
  chapter: Chapter;
  projectId: string;
}) {
  const sectionsQ = useQuery({
    queryKey: queryKeys.chapterSections(chapter.id),
    queryFn: () => api.getChapterSections(chapter.id),
  });

  const sections = sectionsQ.data?.items ?? [];

  return (
    <div className="flex w-full max-w-3xl flex-col gap-3">
      <div className="px-1">
        <div className="text-[11px] text-neutral-500 uppercase tracking-wide">
          Chapter {chapter.ordinal}
        </div>
        <h2 className="mt-0.5 font-serif text-2xl tracking-tight">{chapter.title}</h2>
        {chapter.summary && (
          <p className="mt-1 font-serif text-[14px] text-neutral-600 leading-relaxed dark:text-neutral-400">
            {chapter.summary}
          </p>
        )}
      </div>

      {sectionsQ.isLoading ? (
        <div className="flex flex-col gap-3">
          {[1, 2].map((n) => (
            <div
              key={n}
              className="h-32 animate-pulse rounded-2xl bg-white/50 ring-1 ring-black/5 dark:bg-neutral-900/50 dark:ring-white/5"
            />
          ))}
        </div>
      ) : sections.length === 0 ? (
        <p className="px-1 font-serif text-[13px] text-neutral-400 italic">
          No scenes yet — add scenes from the{' '}
          <Link
            className="underline underline-offset-2 hover:text-neutral-600 dark:hover:text-neutral-300"
            params={{ projectId }}
            to="/studio/$projectId/outline"
          >
            outline
          </Link>
          .
        </p>
      ) : (
        sections.map((section) => (
          <SceneCard key={section.id} section={section} chapterId={chapter.id} />
        ))
      )}
    </div>
  );
}
