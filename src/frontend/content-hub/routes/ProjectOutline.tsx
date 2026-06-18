// Outline builder + read/edit chapter board — ported from
// studio/apps/web/client/routes/_hub.$projectId.outline.tsx.
//
// Changes vs the studio source:
//   - File route (createFileRoute("/_hub/$projectId/outline")) → plain
//     component (ProjectOutline), mounted by spooool's code-based router at
//     /studio/$projectId/outline (router.tsx).
//   - Params/search read via useParams/useSearch({ strict: false }).
//   - Component imports point at the ported copies under ../components and
//     ../lib.
//   - The chapter-editor links (/studio/$projectId/chapters/$chapterId) are a
//     PR-4 route not yet in spooool's typed route tree, so they're plain
//     <a href> (untyped) — they 404 gracefully until that route is registered.
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useParams, useSearch } from '@tanstack/react-router';
import { ArrowLeft, GripVertical, Plus, RefreshCw, SquarePen } from 'lucide-react';
import { useEffect, useRef, useState } from 'react';
import OutlineBuilderQA from '../components/panels/OutlineBuilderQA';
import { BreadcrumbPill } from '../components/studio/BreadcrumbPill';
import { SideDrawer } from '../components/studio/SideDrawer';
import { TopLeftPill } from '../components/studio/TopLeftPill';
import { type Chapter, type Project, type Section, api, queryKeys } from '../lib/api';
import { useDrawerLayout } from '../lib/drawer-layout';
import { useAutosave } from '../lib/use-autosave';

export function ProjectOutline() {
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
  const hasChapters = chapters.length > 0;
  const [showWizard, setShowWizard] = useState(false);

  // When the user just generated an outline from the wizard while it was
  // explicitly open, auto-fold the wizard so they land on the new canvas.
  const prevCount = useRef(chapters.length);
  useEffect(() => {
    if (chapters.length > prevCount.current && showWizard) {
      setShowWizard(false);
    }
    prevCount.current = chapters.length;
  }, [chapters.length, showWizard]);

  const title = project.data?.title ?? 'Untitled book';
  const wizardVisible = !outline.isLoading && (!hasChapters || showWizard);

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
        {wizardVisible ? (
          <>
            {hasChapters && (
              <div className="flex w-full max-w-3xl items-center gap-3">
                <button
                  className="flex items-center gap-1.5 rounded-full bg-neutral-950/90 px-3 py-1.5 text-neutral-200 text-xs hover:bg-neutral-800"
                  onClick={() => setShowWizard(false)}
                  type="button"
                >
                  <ArrowLeft className="size-3" />
                  Back to canvas
                </button>
                <span className="text-amber-700 text-xs dark:text-amber-400">
                  Regenerating will replace existing chapters.
                </span>
              </div>
            )}
            <ConceptBrief fallbackLogline={logline} project={project.data} />
            {project.data ? (
              <OutlineBuilderQA project={project.data} />
            ) : (
              <p className="font-serif text-neutral-500 text-sm">Loading…</p>
            )}
          </>
        ) : (
          <>
            <ConceptBrief fallbackLogline={logline} project={project.data} />

            {outline.isLoading && (
              <p className="font-serif text-neutral-500 text-sm">Loading outline…</p>
            )}

            {hasChapters && (
              <div className="sticky top-20 z-10 flex w-full max-w-3xl items-center justify-between rounded-full bg-neutral-950/90 px-4 py-2 text-neutral-200 shadow-lg ring-1 ring-white/5 backdrop-blur">
                <span className="text-[11px] text-neutral-400">
                  {chapters.length} chapter{chapters.length !== 1 ? 's' : ''}
                </span>
                <button
                  className="flex items-center gap-1.5 rounded-full px-3 py-1 text-[11px] hover:bg-white/10"
                  onClick={() => setShowWizard(true)}
                  type="button"
                  title="Reopen the outline wizard"
                >
                  <RefreshCw className="size-3" />
                  Regenerate outline
                </button>
              </div>
            )}

            {chapters.map((chapter) => (
              <ChapterCanvas key={chapter.id} chapter={chapter} projectId={projectId} />
            ))}
          </>
        )}
      </main>
    </div>
  );
}

// Keeps the compose-wizard answers (logline, genre, audience, voice) visible
// once the author reaches the outline stage. Falls back to the ?logline
// search param for projects created before those answers were persisted.
function ConceptBrief({
  project,
  fallbackLogline,
}: {
  project?: Project;
  fallbackLogline?: string;
}) {
  const conceptLogline = project?.logline?.trim() || fallbackLogline?.trim() || '';
  const genre = project?.genre?.trim() ?? '';
  const audience = project?.audience_json ?? [];
  const voiceStyles = project?.voice_styles_json ?? [];
  const hasDetails = Boolean(genre) || audience.length > 0 || voiceStyles.length > 0;
  if (!conceptLogline && !hasDetails) return null;

  return (
    <div className="w-full max-w-3xl">
      <details className="rounded-2xl bg-neutral-950/90 px-5 py-3 text-neutral-200 ring-1 ring-white/5">
        <summary className="cursor-pointer list-none">
          <div className="flex items-center justify-between">
            <span className="text-[11px] text-neutral-400 uppercase tracking-wide">
              Your concept
            </span>
            {hasDetails && <span className="text-[11px] text-neutral-500">show answers</span>}
          </div>
          {conceptLogline && (
            <p className="mt-1 font-serif text-[15px] leading-relaxed">{conceptLogline}</p>
          )}
        </summary>
        {hasDetails && (
          <div className="mt-3 space-y-1.5 border-white/10 border-t pt-3">
            {project?.type && <BriefRow label="Type" value={project.type} />}
            {genre && <BriefRow label="Genre" value={genre} />}
            {audience.length > 0 && <BriefRow label="Audience" value={audience.join(' · ')} />}
            {voiceStyles.length > 0 && <BriefRow label="Voice" value={voiceStyles.join(' · ')} />}
          </div>
        )}
      </details>
    </div>
  );
}

function BriefRow({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex items-baseline gap-3 text-sm">
      <span className="w-20 shrink-0 text-[11px] text-neutral-500 uppercase tracking-wide">
        {label}
      </span>
      <span className="text-neutral-300">{value}</span>
    </div>
  );
}

function ChapterCanvas({
  chapter,
  projectId,
}: {
  chapter: Chapter;
  projectId: string;
}) {
  const queryClient = useQueryClient();
  const sectionsQ = useQuery({
    queryKey: queryKeys.chapterSections(chapter.id),
    queryFn: () => api.getChapterSections(chapter.id),
  });
  const [dragOverSectionId, setDragOverSectionId] = useState<string | null>(null);
  const [chapterDropOver, setChapterDropOver] = useState(false);

  const createMutation = useMutation({
    mutationFn: () => api.createSection(chapter.id),
    onSuccess: () =>
      queryClient.invalidateQueries({ queryKey: queryKeys.chapterSections(chapter.id) }),
  });

  const items = sectionsQ.data?.items ?? [];

  function handleDragOver(e: React.DragEvent, sectionId: string) {
    e.preventDefault();
    setDragOverSectionId(sectionId);
    setChapterDropOver(false);
  }

  function handleChapterDragOver(e: React.DragEvent) {
    e.preventDefault();
    setChapterDropOver(true);
    setDragOverSectionId(null);
  }

  async function handleDrop(e: React.DragEvent, targetSectionId: string | null) {
    e.preventDefault();
    setDragOverSectionId(null);
    setChapterDropOver(false);
    const raw = e.dataTransfer.getData('text/plain');
    if (!raw) return;
    const { sectionId, fromChapterId } = JSON.parse(raw) as {
      sectionId: string;
      fromChapterId: string;
    };

    if (fromChapterId !== chapter.id) {
      await api.moveSectionToChapter(fromChapterId, sectionId, chapter.id);
      await queryClient.invalidateQueries({
        queryKey: queryKeys.chapterSections(fromChapterId),
      });
      await queryClient.invalidateQueries({ queryKey: queryKeys.chapterSections(chapter.id) });
      return;
    }

    const current = [...items];
    const fromIdx = current.findIndex((s) => s.id === sectionId);
    const toIdx = targetSectionId
      ? current.findIndex((s) => s.id === targetSectionId)
      : current.length - 1;
    if (fromIdx === -1 || fromIdx === toIdx) return;
    const reordered = [...current];
    const [moved] = reordered.splice(fromIdx, 1);
    if (!moved) return;
    reordered.splice(toIdx, 0, moved);
    const ordinals = reordered.map((s, i) => ({ id: s.id, ordinal: i + 1 }));
    await api.reorderSections(chapter.id, ordinals);
    await queryClient.invalidateQueries({ queryKey: queryKeys.chapterSections(chapter.id) });
  }

  return (
    <div
      className={`flex w-full max-w-3xl flex-col gap-2 rounded-2xl p-4 transition ${
        chapterDropOver ? 'ring-2 ring-emerald-500/40' : ''
      }`}
      onDragOver={handleChapterDragOver}
      onDragLeave={() => setChapterDropOver(false)}
      onDrop={(e) => handleDrop(e, null)}
    >
      <ChapterHeading chapter={chapter} projectId={projectId} />
      {sectionsQ.isLoading ? (
        <p className="py-2 font-serif text-neutral-500 text-sm">Loading…</p>
      ) : (
        <div className="flex flex-col gap-1.5">
          {items.map((section, i) => (
            <SceneSummaryCard
              key={section.id}
              section={section}
              chapterId={chapter.id}
              projectId={projectId}
              index={i + 1}
              isDragOver={dragOverSectionId === section.id}
              onDragOver={(e) => handleDragOver(e, section.id)}
              onDrop={(e) => handleDrop(e, section.id)}
            />
          ))}
          <button
            className="mt-1 flex items-center gap-1.5 self-start rounded-full bg-neutral-950/80 px-3 py-1.5 text-[11px] text-neutral-400 ring-1 ring-white/5 backdrop-blur transition hover:text-neutral-200 disabled:opacity-50"
            disabled={createMutation.isPending}
            onClick={() => createMutation.mutate()}
            type="button"
          >
            <Plus className="size-3" />
            Add scene
          </button>
        </div>
      )}
    </div>
  );
}

function SceneSummaryCard({
  section,
  chapterId,
  projectId,
  index,
  isDragOver,
  onDragOver,
  onDrop,
}: {
  section: Section;
  chapterId: string;
  projectId: string;
  index: number;
  isDragOver: boolean;
  onDragOver: (e: React.DragEvent) => void;
  onDrop: (e: React.DragEvent) => void;
}) {
  const [editing, setEditing] = useState(false);
  // useAutosave handles the debounce, aborts superseded requests, and ignores
  // out-of-order responses — replacing the hand-rolled timer that could let an
  // older save overwrite newer content (ALO autosave race fix).
  const [summary, setSummary] = useAutosave(section.prompt, (next, signal) =>
    api.updateSection(chapterId, section.id, { prompt: next }, { signal }),
  );

  return (
    <div
      className={`group flex items-center gap-2 rounded-xl bg-white/70 px-3 py-2.5 ring-1 transition dark:bg-neutral-900/70 ${
        isDragOver ? 'ring-emerald-500/50' : 'ring-black/5 dark:ring-white/5'
      }`}
      draggable
      onDragStart={(e) => {
        e.dataTransfer.setData(
          'text/plain',
          JSON.stringify({ sectionId: section.id, fromChapterId: chapterId }),
        );
        e.dataTransfer.effectAllowed = 'move';
      }}
      onDragOver={onDragOver}
      onDrop={onDrop}
    >
      <GripVertical className="size-3.5 shrink-0 cursor-grab text-neutral-400 active:cursor-grabbing" />
      <span className="w-14 shrink-0 text-[10px] text-neutral-400 uppercase tracking-wide">
        Scene {index}
      </span>
      {editing ? (
        <input
          autoComplete="off"
          className="min-w-0 flex-1 bg-transparent font-serif text-sm outline-none placeholder:text-neutral-400"
          id={`scene-summary-${section.id}`}
          name={`scene-summary-${section.id}`}
          onBlur={() => setEditing(false)}
          onChange={(e) => setSummary(e.target.value)}
          onKeyDown={(e) => e.key === 'Enter' && setEditing(false)}
          placeholder="Scene summary…"
          ref={(el) => el?.focus()}
          value={summary}
        />
      ) : (
        <button
          className="min-w-0 flex-1 truncate text-left font-serif text-sm text-neutral-700 hover:text-neutral-900 dark:text-neutral-300 dark:hover:text-neutral-100"
          onClick={() => setEditing(true)}
          type="button"
        >
          {summary || <span className="text-neutral-400 italic">No summary yet</span>}
        </button>
      )}
      {/* Chapter editor (/studio/$projectId/chapters/$chapterId) is a PR-4 route
          not in the typed tree yet — plain <a href> until it's registered. */}
      <a
        className="shrink-0 rounded-md px-2 py-1 text-[10px] text-neutral-400 opacity-0 ring-1 ring-transparent transition hover:bg-white/10 hover:text-neutral-200 hover:ring-white/10 group-hover:opacity-100"
        href={`/studio/${projectId}/chapters/${chapterId}`}
      >
        Open →
      </a>
    </div>
  );
}

function ChapterHeading({ chapter, projectId }: { chapter: Chapter; projectId: string }) {
  const queryClient = useQueryClient();
  // useAutosave debounces, aborts superseded requests, and ignores out-of-order
  // responses so a slow earlier save can't clobber a newer title (autosave
  // race fix). It also tears down the timer + in-flight request on unmount.
  const [title, setTitle, saving] = useAutosave(chapter.title, async (next, signal) => {
    await api.updateChapter(chapter.id, { title: next.trim() }, { signal });
    queryClient.invalidateQueries({ queryKey: queryKeys.projectOutline(projectId) });
  });

  return (
    <div className="px-1">
      <div className="flex items-center gap-2">
        <div className="text-[11px] text-neutral-500 uppercase tracking-wide">
          Chapter {chapter.ordinal}
        </div>
        {saving === 'saving' && <span className="text-[11px] text-neutral-500">Saving…</span>}
        {saving === 'saved' && (
          <span className="text-[11px] text-emerald-600 dark:text-emerald-400">Saved</span>
        )}
        {saving === 'error' && <span className="text-[11px] text-red-500">Save failed</span>}
      </div>
      <div className="mt-1 flex items-center gap-2">
        <input
          aria-label="Chapter title"
          autoComplete="off"
          className="min-w-0 flex-1 bg-transparent font-serif text-2xl tracking-tight outline-none placeholder:text-neutral-400 focus:-mx-1 focus:rounded focus:bg-black/5 focus:px-1 dark:focus:bg-white/5"
          id={`chapter-${chapter.ordinal}-title`}
          name={`chapter-${chapter.ordinal}-title`}
          onChange={(e) => setTitle(e.target.value)}
          placeholder="Untitled chapter"
          value={title}
        />
        {/* Chapter editor is a PR-4 route — plain <a href> until registered. */}
        <a
          aria-label="Open chapter editor"
          className="grid size-8 shrink-0 place-items-center rounded-md text-neutral-500 hover:bg-black/5 hover:text-neutral-900 dark:hover:bg-white/10 dark:hover:text-neutral-100"
          href={`/studio/${projectId}/chapters/${chapter.id}`}
          title="Open chapter editor"
        >
          <SquarePen className="size-4" />
        </a>
      </div>
      {chapter.summary && (
        <p className="mt-1 font-serif text-[14px] text-neutral-600 leading-relaxed dark:text-neutral-400">
          {chapter.summary}
        </p>
      )}
    </div>
  );
}
