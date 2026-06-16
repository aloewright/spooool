// Section-level chapter editor (sub-project #4, PR-6) — ported from
// studio/apps/web/client/routes/_hub.$projectId.chapters.$chapterId.tsx.
//
// This is the flat-block drag editor + autosave; it is NOT a BlockNote editor
// (chapters edit per-section beginning/middle/end markdown via plain textareas),
// so it pulls NO @blocknote deps and lands in the regular /studio async chunk.
//
// Ported verbatim aside from:
//   - file-route → plain component: `createFileRoute(...)` is gone; the route
//     is registered in router.tsx. Params come from the typed
//     projectChapterRoute.useParams() (passed in as props from router.tsx so
//     this stays a pure component and tests can mount it directly).
//   - `<Link to="/$projectId/outline">` (studio app-relative) →
//     `<Link to="/studio/$projectId/outline">` (spooool absolute). Same for the
//     prev/next chapter links → `/studio/$projectId/chapters/$chapterId`.
//   - import paths already match the spooool content-hub layout
//     (../components/studio/*, ../lib/*).
import { Link } from '@tanstack/react-router';
import { useQuery } from '@tanstack/react-query';
import { ArrowLeft, ArrowRight, ChevronLeft, GripVertical, Lock, Unlock } from 'lucide-react';
import { type JSX, useRef, useState } from 'react';
import { SideDrawer } from '../components/studio/SideDrawer';
import { TopLeftPill } from '../components/studio/TopLeftPill';
import { type Section, api, queryKeys } from '../lib/api';
import { useDrawerLayout } from '../lib/drawer-layout';
import { type SaveState, useAutosave } from '../lib/use-autosave';

type BmeFieldName = 'beginning_md' | 'middle_md' | 'end_md';
type FlatBlockItem = { sectionId: string; field: BmeFieldName; label: string };

export function ProjectChapter({
  projectId,
  chapterId,
}: {
  projectId: string;
  chapterId: string;
}): JSX.Element {
  const drawer = useDrawerLayout();
  const [unlocked, setUnlocked] = useState(false);
  const [flatOrder, setFlatOrder] = useState<FlatBlockItem[]>([]);
  const [flatDragIdx, setFlatDragIdx] = useState<number | null>(null);
  const [flatDragOverIdx, setFlatDragOverIdx] = useState<number | null>(null);
  const mainRef = useRef<HTMLDivElement>(null);

  const project = useQuery({
    queryKey: queryKeys.project(projectId),
    queryFn: () => api.getProject(projectId),
  });
  const chapter = useQuery({
    queryKey: queryKeys.chapter(chapterId),
    queryFn: () => api.getChapter(chapterId),
  });
  const sectionsQ = useQuery({
    queryKey: queryKeys.chapterSections(chapterId),
    queryFn: () => api.getChapterSections(chapterId),
  });
  const outline = useQuery({
    queryKey: queryKeys.projectOutline(projectId),
    queryFn: () => api.getProjectOutline(projectId),
  });

  const scenes = sectionsQ.data?.items ?? [];
  const allChapters = outline.data?.chapters ?? [];
  const idx = allChapters.findIndex((c) => c.id === chapterId);
  const prevChapter = idx > 0 ? allChapters[idx - 1] : null;
  const nextChapter = idx < allChapters.length - 1 ? allChapters[idx + 1] : null;

  function buildFlatBlocks(items: Section[]): FlatBlockItem[] {
    return items.flatMap((s) => [
      {
        sectionId: s.id,
        field: 'beginning_md' as BmeFieldName,
        label: `Scene ${s.ordinal} · Beginning`,
      },
      { sectionId: s.id, field: 'middle_md' as BmeFieldName, label: `Scene ${s.ordinal} · Middle` },
      { sectionId: s.id, field: 'end_md' as BmeFieldName, label: `Scene ${s.ordinal} · End` },
    ]);
  }

  function handleUnlock() {
    if (!unlocked) setFlatOrder(buildFlatBlocks(scenes));
    setUnlocked((v) => !v);
  }

  function scrollToScene(sectionId: string) {
    const el = document.getElementById(`scene-${sectionId}`);
    el?.scrollIntoView({ behavior: 'smooth', block: 'start' });
  }

  function handleFlatDrop(toIdx: number) {
    if (flatDragIdx === null || flatDragIdx === toIdx) {
      setFlatDragIdx(null);
      setFlatDragOverIdx(null);
      return;
    }
    const next = [...flatOrder];
    const [moved] = next.splice(flatDragIdx, 1);
    if (!moved) return;
    next.splice(toIdx, 0, moved);
    setFlatOrder(next);
    setFlatDragIdx(null);
    setFlatDragOverIdx(null);
  }

  const title = project.data?.title ?? 'Untitled';
  const chapterLabel = chapter.data
    ? `Ch ${chapter.data.ordinal}: ${chapter.data.title}`
    : 'Chapter';

  return (
    <div className="fixed inset-0 flex overflow-hidden bg-[#1a1a1a] text-neutral-100">
      <SideDrawer projectId={projectId} current="outline" />
      <TopLeftPill />

      {/* Top bar */}
      <div className="pointer-events-none absolute inset-x-0 top-0 z-20 flex items-center gap-3 bg-[#1a1a1a]/80 py-3 pl-20 pr-5 backdrop-blur">
        <div className="pointer-events-auto flex min-w-0 flex-1 items-center gap-2">
          <Link
            className="flex items-center gap-1 rounded-lg px-2 py-1 text-[11px] text-neutral-400 hover:bg-white/10 hover:text-neutral-200"
            params={{ projectId }}
            to="/studio/$projectId/outline"
          >
            <ChevronLeft className="size-3" />
            Outline
          </Link>
          <span className="text-neutral-600">/</span>
          <span className="truncate text-sm font-medium text-neutral-200">{title}</span>
          <span className="text-neutral-600">/</span>
          <span className="truncate text-[13px] text-neutral-400">{chapterLabel}</span>
        </div>
        <div className="pointer-events-auto flex items-center gap-2">
          {prevChapter && (
            <Link
              className="flex items-center gap-1 rounded-lg px-2 py-1 text-[11px] text-neutral-400 hover:bg-white/10 hover:text-neutral-200"
              params={{ projectId, chapterId: prevChapter.id }}
              to="/studio/$projectId/chapters/$chapterId"
            >
              <ArrowLeft className="size-3" />
              Ch {prevChapter.ordinal}
            </Link>
          )}
          {nextChapter && (
            <Link
              className="flex items-center gap-1 rounded-lg px-2 py-1 text-[11px] text-neutral-400 hover:bg-white/10 hover:text-neutral-200"
              params={{ projectId, chapterId: nextChapter.id }}
              to="/studio/$projectId/chapters/$chapterId"
            >
              Ch {nextChapter.ordinal}
              <ArrowRight className="size-3" />
            </Link>
          )}
        </div>
      </div>

      {/* Main scrollable column */}
      <main
        ref={mainRef}
        className="flex-1 overflow-y-auto px-8 pb-28 pt-20 transition-[padding] duration-200"
        style={{
          paddingLeft: drawer.open ? (drawer.collapsed ? '5rem' : '20rem') : undefined,
        }}
      >
        <div className="mx-auto max-w-2xl">
          {chapter.data && (
            <div className="mb-8">
              <div className="text-[11px] text-neutral-500 uppercase tracking-wide">
                Chapter {chapter.data.ordinal}
              </div>
              <h1 className="mt-1 font-serif text-3xl tracking-tight">{chapter.data.title}</h1>
              {chapter.data.summary && (
                <p className="mt-2 font-serif text-[14px] text-neutral-400 leading-relaxed">
                  {chapter.data.summary}
                </p>
              )}
            </div>
          )}

          {sectionsQ.isLoading && (
            <p className="font-serif text-neutral-500 text-sm">Loading scenes…</p>
          )}

          {!unlocked &&
            scenes.map((section, i) => (
              <SceneBlock key={section.id} section={section} chapterId={chapterId} index={i + 1} />
            ))}

          {unlocked && (
            <div className="flex flex-col gap-3">
              <p className="text-[11px] text-neutral-500 uppercase tracking-wide">
                Unlocked — drag blocks to reorder freely
              </p>
              {flatOrder.map((block, i) => {
                const section = scenes.find((s) => s.id === block.sectionId);
                if (!section) return null;
                return (
                  <FlatBlock
                    key={`${block.sectionId}-${block.field}`}
                    block={block}
                    value={section[block.field]}
                    chapterId={chapterId}
                    sectionId={block.sectionId}
                    isDragOver={flatDragOverIdx === i}
                    onDragStart={() => setFlatDragIdx(i)}
                    onDragOver={(e) => {
                      e.preventDefault();
                      setFlatDragOverIdx(i);
                    }}
                    onDrop={() => handleFlatDrop(i)}
                  />
                );
              })}
            </div>
          )}
        </div>
      </main>

      {/* Right TOC pill */}
      {scenes.length > 0 && (
        <nav className="fixed right-4 top-1/2 z-10 flex -translate-y-1/2 flex-col gap-1 rounded-2xl bg-neutral-900/90 px-3 py-3 ring-1 ring-white/5 backdrop-blur">
          <span className="mb-1 text-[9px] text-neutral-500 uppercase tracking-widest">Scenes</span>
          {scenes.map((s, i) => (
            <button
              key={s.id}
              className="truncate rounded-lg px-2 py-1 text-left text-[11px] text-neutral-400 transition hover:bg-white/10 hover:text-neutral-200"
              onClick={() => scrollToScene(s.id)}
              style={{ maxWidth: '9rem' }}
              type="button"
            >
              <span className="mr-1.5 text-neutral-600">{i + 1}</span>
              {s.prompt || 'Scene'}
            </button>
          ))}
        </nav>
      )}

      {/* Bottom unlock button */}
      <div className="-translate-x-1/2 fixed bottom-6 left-1/2 z-20">
        <button
          className={`flex items-center gap-2 rounded-full px-4 py-2 text-sm ring-1 transition ${
            unlocked
              ? 'bg-emerald-600/20 text-emerald-300 ring-emerald-500/30 hover:bg-emerald-600/30'
              : 'bg-neutral-900/90 text-neutral-400 ring-white/5 backdrop-blur hover:text-neutral-200'
          }`}
          onClick={handleUnlock}
          type="button"
        >
          {unlocked ? <Unlock className="size-3.5" /> : <Lock className="size-3.5" />}
          {unlocked ? 'Lock structure' : 'Unlock structure'}
        </button>
      </div>
    </div>
  );
}

function SceneBlock({
  section,
  chapterId,
  index,
}: {
  section: Section;
  chapterId: string;
  index: number;
}) {
  const [summary, setSummary] = useAutosave(section.prompt, (v, sig) =>
    api.updateSection(chapterId, section.id, { prompt: v }, { signal: sig }),
  );
  const [beginning, setBeginning, beginState] = useAutosave(section.beginning_md, (v, sig) =>
    api.updateSection(chapterId, section.id, { beginning_md: v }, { signal: sig }),
  );
  const [middle, setMiddle, midState] = useAutosave(section.middle_md, (v, sig) =>
    api.updateSection(chapterId, section.id, { middle_md: v }, { signal: sig }),
  );
  const [end, setEnd, endState] = useAutosave(section.end_md, (v, sig) =>
    api.updateSection(chapterId, section.id, { end_md: v }, { signal: sig }),
  );

  const saveState: SaveState = [beginState, midState, endState].includes('error')
    ? 'error'
    : [beginState, midState, endState].includes('saving')
      ? 'saving'
      : [beginState, midState, endState].includes('saved')
        ? 'saved'
        : 'idle';

  return (
    <section
      className="mb-10 rounded-2xl bg-neutral-900/60 p-6 ring-1 ring-white/5"
      id={`scene-${section.id}`}
    >
      <div className="mb-4 flex items-center justify-between">
        <span className="text-[11px] text-neutral-500 uppercase tracking-widest">Scene {index}</span>
        <SaveDot state={saveState} />
      </div>

      {/* Summary / scene title */}
      <textarea
        aria-label="Scene summary"
        className="mb-5 w-full resize-none bg-transparent font-serif text-lg text-neutral-200 leading-snug outline-none placeholder:text-neutral-600"
        onChange={(e) => setSummary(e.target.value)}
        placeholder="Scene summary…"
        rows={2}
        value={summary}
      />

      <BmeField field="beginning_md" label="Beginning" value={beginning} onChange={setBeginning} />
      <BmeField field="middle_md" label="Middle" value={middle} onChange={setMiddle} />
      <BmeField field="end_md" label="End" value={end} onChange={setEnd} />
    </section>
  );
}

function BmeField({
  label,
  value,
  onChange,
}: {
  label: string;
  value: string;
  onChange: (v: string) => void;
  field: BmeFieldName;
}) {
  return (
    <div className="mb-5">
      <div className="mb-1.5 text-[9px] text-neutral-500 uppercase tracking-widest">{label}</div>
      <textarea
        aria-label={label}
        className="w-full resize-none bg-transparent font-serif text-[15px] text-neutral-300 leading-relaxed outline-none placeholder:text-neutral-700 focus:text-neutral-100"
        onChange={(e) => onChange(e.target.value)}
        placeholder={`${label} of the scene…`}
        rows={Math.max(3, (value.split('\n').length || 1) + 1)}
        value={value}
      />
    </div>
  );
}

function FlatBlock({
  block,
  value,
  chapterId,
  sectionId,
  isDragOver,
  onDragStart,
  onDragOver,
  onDrop,
}: {
  block: FlatBlockItem;
  value: string;
  chapterId: string;
  sectionId: string;
  isDragOver: boolean;
  onDragStart: () => void;
  onDragOver: (e: React.DragEvent) => void;
  onDrop: () => void;
}) {
  const [local, setLocal, saveState] = useAutosave(value, (v, sig) =>
    api.updateSection(chapterId, sectionId, { [block.field]: v }, { signal: sig }),
  );

  return (
    <div
      className={`rounded-xl bg-neutral-900/70 p-4 ring-1 transition ${
        isDragOver ? 'ring-emerald-500/50' : 'ring-white/5'
      }`}
      draggable
      onDragEnd={() => {}}
      onDragOver={onDragOver}
      onDragStart={onDragStart}
      onDrop={onDrop}
    >
      <div className="mb-2 flex items-center gap-2">
        <GripVertical className="size-3.5 cursor-grab text-neutral-600 active:cursor-grabbing" />
        <span className="text-[9px] text-neutral-500 uppercase tracking-widest">{block.label}</span>
        <SaveDot state={saveState} />
      </div>
      <textarea
        className="w-full resize-none bg-transparent font-serif text-[15px] text-neutral-300 leading-relaxed outline-none placeholder:text-neutral-700 focus:text-neutral-100"
        onChange={(e) => setLocal(e.target.value)}
        rows={Math.max(3, (local.split('\n').length || 1) + 1)}
        value={local}
      />
    </div>
  );
}

function SaveDot({ state }: { state: SaveState }) {
  if (state === 'saving') return <span className="text-[10px] text-neutral-500">Saving…</span>;
  if (state === 'saved') return <span className="text-[10px] text-emerald-500">Saved</span>;
  if (state === 'error') return <span className="text-[10px] text-red-500">Error</span>;
  return null;
}
