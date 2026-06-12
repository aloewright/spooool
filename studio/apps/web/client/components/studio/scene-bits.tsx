import { useMutation, useQueryClient } from "@tanstack/react-query";
import { FileText, LayoutTemplate, Sparkles } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { type Section, api, queryKeys } from "../../lib/api";

type SaveState = "idle" | "saving" | "saved" | "error";

export function SceneCard({
  section,
  chapterId,
}: {
  section: Section;
  chapterId: string;
}) {
  const [body, setBody] = useState(section.draft_md);
  const [saveState, setSaveState] = useState<SaveState>("idle");
  const [pendingDraft, setPendingDraft] = useState(false);
  const timerRef = useRef<number | undefined>(undefined);
  const lastSaved = useRef(section.draft_md);

  useEffect(() => {
    if (body !== lastSaved.current) return;
    if (section.draft_md === lastSaved.current) return;
    setBody(section.draft_md);
    lastSaved.current = section.draft_md;
    setSaveState("idle");
  }, [section.draft_md, body]);

  useEffect(
    () => () => {
      if (timerRef.current) clearTimeout(timerRef.current);
    },
    [],
  );

  function handleChange(next: string) {
    setBody(next);
    if (timerRef.current) clearTimeout(timerRef.current);
    if (next === lastSaved.current) {
      setSaveState("idle");
      return;
    }
    setSaveState("saving");
    timerRef.current = window.setTimeout(async () => {
      try {
        await api.updateSection(chapterId, section.id, { draft_md: next });
        lastSaved.current = next;
        setSaveState("saved");
      } catch {
        setSaveState("error");
      }
    }, 800);
  }

  return (
    <div className="flex flex-col gap-3 rounded-2xl bg-white/70 p-4 ring-1 ring-black/5 dark:bg-neutral-900/70 dark:ring-white/5">
      <div className="flex items-center justify-between">
        <span className="text-[10px] text-neutral-400 uppercase tracking-wide">
          Scene {section.ordinal}
        </span>
        <SaveIndicator state={saveState} />
      </div>

      {section.prompt && (
        <p className="font-serif text-[12px] text-neutral-500 dark:text-neutral-400">
          {section.prompt}
        </p>
      )}

      {pendingDraft ? (
        <div className="flex flex-col gap-2">
          <div className="h-4 w-3/4 animate-pulse rounded bg-neutral-200 dark:bg-neutral-800" />
          <div className="h-4 w-full animate-pulse rounded bg-neutral-200 dark:bg-neutral-800" />
          <div className="h-4 w-5/6 animate-pulse rounded bg-neutral-200 dark:bg-neutral-800" />
          <div className="h-4 w-2/3 animate-pulse rounded bg-neutral-200 dark:bg-neutral-800" />
        </div>
      ) : (
        <textarea
          aria-label={`Scene ${section.ordinal} body`}
          className="w-full resize-none bg-transparent font-serif text-[15px] text-neutral-800 leading-relaxed outline-none placeholder:text-neutral-400 dark:text-neutral-200"
          onChange={(e) => handleChange(e.target.value)}
          placeholder="Write your scene here…"
          rows={Math.max(4, (body.split("\n").length || 1) + 1)}
          value={body}
        />
      )}

      <InsertBar chapterId={chapterId} sectionId={section.id} onPendingChange={setPendingDraft} />
    </div>
  );
}

export function InsertBar({
  chapterId,
  sectionId,
  onPendingChange,
}: {
  chapterId: string;
  sectionId: string;
  onPendingChange: (isPending: boolean) => void;
}) {
  const queryClient = useQueryClient();

  const draftMutation = useMutation({
    mutationFn: (instruction: string | undefined) =>
      api.draftSection(
        chapterId,
        sectionId,
        instruction !== undefined ? { instruction } : undefined,
      ),
    onMutate: () => onPendingChange(true),
    onSettled: () => {
      onPendingChange(false);
      queryClient.invalidateQueries({ queryKey: queryKeys.chapterSections(chapterId) });
    },
  });

  const btnCls =
    "flex items-center gap-1.5 rounded-full px-2.5 py-1 text-[11px] transition disabled:opacity-50";

  return (
    <div className="flex items-center gap-0.5 self-start rounded-full bg-neutral-950/80 px-1.5 py-1 ring-1 ring-white/5 backdrop-blur">
      <button
        className={`${btnCls} text-neutral-300 hover:bg-white/10 hover:text-neutral-100`}
        disabled={draftMutation.isPending}
        onClick={() => draftMutation.mutate(undefined)}
        type="button"
      >
        <Sparkles className="size-3" />
        Generate with AI
      </button>
      <div className="h-3 w-px bg-white/10" />
      <button
        className={`${btnCls} text-neutral-400 hover:bg-white/10 hover:text-neutral-200`}
        disabled={draftMutation.isPending}
        onClick={() => draftMutation.mutate("")}
        type="button"
      >
        <FileText className="size-3" />
        Blank scene
      </button>
      <div className="h-3 w-px bg-white/10" />
      <button
        className={`${btnCls} text-neutral-400 hover:bg-white/10 hover:text-neutral-200`}
        disabled={draftMutation.isPending}
        onClick={() =>
          draftMutation.mutate(
            "Write a scene following the three-act structure: establish the setting and character motivation in the opening, build tension through the middle, and resolve with a clear consequence that advances the story.",
          )
        }
        type="button"
      >
        <LayoutTemplate className="size-3" />
        Start with template
      </button>
    </div>
  );
}

function SaveIndicator({ state }: { state: SaveState }) {
  if (state === "saving") return <span className="text-[10px] text-neutral-500">Saving…</span>;
  if (state === "saved") return <span className="text-[10px] text-emerald-500">Saved</span>;
  if (state === "error") return <span className="text-[10px] text-red-500">Error</span>;
  return null;
}
