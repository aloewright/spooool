import "@blocknote/core/fonts/inter.css";
import "@blocknote/mantine/style.css";
import { getScriptFormat } from "@/shared/script-formats";
import { BlockNoteView } from "@blocknote/mantine";
import { useCreateBlockNote } from "@blocknote/react";
import { layout, prepare } from "@chenglou/pretext";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { createFileRoute } from "@tanstack/react-router";
import { Clapperboard } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { ScriptShell } from "../components/studio/ScriptShell";
import { type Script, type ScriptScene, api, queryKeys } from "../lib/api";
import { type SaveState, useAutosave } from "../lib/use-autosave";
import { useDarkMode } from "../lib/use-theme-mode";

export const Route = createFileRoute("/_hub/scripts/$scriptId/scenes/$sceneId")({
  component: ScriptSceneEditor,
});

// A screenplay page is ~55 lines of mono type in a ~6-inch column, and reads
// as roughly one minute of screen time. Pretext measures the draft with pure
// arithmetic (no DOM reflow), so this is cheap to redo on every save.
function useScreenplayPages(draftMd: string): number | null {
  const [pages, setPages] = useState<number | null>(null);
  useEffect(() => {
    let cancelled = false;
    (async () => {
      if (!draftMd.trim()) {
        setPages(null);
        return;
      }
      try {
        const prepared = await prepare(draftMd, '16px "JetBrains Mono", monospace');
        if (cancelled) return;
        const { lineCount } = layout(prepared, 576, 24);
        setPages(Math.max(0.1, Math.round((lineCount / 55) * 10) / 10));
      } catch {
        if (!cancelled) setPages(null);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [draftMd]);
  return pages;
}

function ScriptSceneEditor() {
  const { scriptId, sceneId } = Route.useParams();
  const script = useQuery({
    queryKey: queryKeys.script(scriptId),
    queryFn: () => api.getScript(scriptId),
  });
  const scene = useQuery({
    queryKey: queryKeys.scriptScene(scriptId, sceneId),
    queryFn: () => api.getScriptScene(scriptId, sceneId),
  });

  if (script.isLoading || scene.isLoading) {
    return (
      <ScriptShell current="scenes" scriptId={scriptId} title="Scene">
        <p className="text-neutral-500">Loading…</p>
      </ScriptShell>
    );
  }
  if (script.isError || scene.isError) {
    const err = script.error ?? scene.error;
    return (
      <ScriptShell current="scenes" scriptId={scriptId} title="Scene">
        <p className="text-neutral-500">
          Couldn't load this scene{err instanceof Error ? ` — ${err.message}` : ""}.
        </p>
      </ScriptShell>
    );
  }
  if (!script.data || !scene.data) {
    return (
      <ScriptShell current="scenes" scriptId={scriptId} title="Scene">
        <p className="text-neutral-500">Scene not found.</p>
      </ScriptShell>
    );
  }

  return (
    <ScriptShell current="scenes" scriptId={scriptId} title={script.data.title}>
      <Editor key={scene.data.id} scene={scene.data} script={script.data} />
    </ScriptShell>
  );
}

function Editor({ script, scene }: { script: Script; scene: ScriptScene }) {
  const qc = useQueryClient();
  const format = getScriptFormat(script.format);
  const darkMode = useDarkMode();
  const pendingSave = useRef<number | undefined>(undefined);
  const inFlight = useRef<AbortController | null>(null);
  const gen = useRef(0);
  const hydratedMarkdown = useRef(false);
  const [hasDraftContent, setHasDraftContent] = useState(scene.draft_md.trim().length > 0);
  // True from the first keystroke until the save that captured it settles, so
  // the badge can't show "Saved" during the debounce window.
  const [isDirty, setIsDirty] = useState(false);
  // Last-saved markdown, fed to the Pretext page estimate.
  const [measuredMd, setMeasuredMd] = useState(scene.draft_md);
  const pages = useScreenplayPages(measuredMd);

  const editor = useCreateBlockNote({
    initialContent:
      Array.isArray(scene.draft_json) && looksLikeBlocks(scene.draft_json)
        ? scene.draft_json
        : undefined,
  });

  // Scenes drafted outside the BlockNote editor only have markdown; hydrate
  // it into blocks once so nothing written elsewhere is lost.
  useEffect(() => {
    if (hydratedMarkdown.current) return;
    hydratedMarkdown.current = true;
    if (looksLikeBlocks(scene.draft_json)) return;
    if (!scene.draft_md.trim()) return;
    editor.replaceBlocks(editor.document, editor.tryParseMarkdownToBlocks(scene.draft_md));
  }, [editor, scene.draft_json, scene.draft_md]);

  const saveDraft = useMutation({
    mutationFn: async () => {
      // Serialize the live document and supersede any in-flight save so an
      // older request can't land after (and overwrite) a newer one.
      inFlight.current?.abort();
      const ctrl = new AbortController();
      inFlight.current = ctrl;
      const g = ++gen.current;
      const draftJson = editor.document;
      const draftMd = editor.blocksToMarkdownLossy(editor.document);
      try {
        await api.updateScriptScene(
          script.id,
          scene.id,
          { draft_json: draftJson, draft_md: draftMd },
          { signal: ctrl.signal },
        );
      } catch (err) {
        if (ctrl.signal.aborted) return { draftMd, superseded: true };
        throw err;
      }
      return { draftMd, superseded: g !== gen.current };
    },
    onSuccess: ({ draftMd, superseded }) => {
      if (superseded) return;
      setIsDirty(false);
      setHasDraftContent(draftMd.trim().length > 0);
      setMeasuredMd(draftMd);
      // The server promotes a planned scene to drafting when its first draft
      // content lands; refetch so the status chip reflects that.
      if (scene.status === "planned" && draftMd.trim()) {
        qc.invalidateQueries({ queryKey: queryKeys.scriptScene(script.id, scene.id) });
        qc.invalidateQueries({ queryKey: queryKeys.scriptScenes(script.id) });
      }
    },
    onError: () => setIsDirty(false),
  });

  // Flush (not drop) a pending debounced save when the editor unmounts so
  // edits made just before navigating away still land.
  const flushRef = useRef<() => void>(() => {});
  flushRef.current = () => {
    if (pendingSave.current) {
      window.clearTimeout(pendingSave.current);
      pendingSave.current = undefined;
      saveDraft.mutate();
    }
  };
  useEffect(() => () => flushRef.current(), []);

  const [title, setTitle, titleState] = useAutosave(scene.title, (v, sig) =>
    api.updateScriptScene(script.id, scene.id, { title: v }, { signal: sig }),
  );
  const [summary, setSummary, summaryState] = useAutosave(scene.summary, (v, sig) =>
    api.updateScriptScene(script.id, scene.id, { summary: v }, { signal: sig }),
  );

  const setStatus = useMutation({
    mutationFn: (status: ScriptScene["status"]) =>
      api.updateScriptScene(script.id, scene.id, { status }),
    onSuccess: () =>
      Promise.all([
        qc.invalidateQueries({ queryKey: queryKeys.scriptScene(script.id, scene.id) }),
        qc.invalidateQueries({ queryKey: queryKeys.scriptScenes(script.id) }),
      ]),
  });

  const draftState: SaveState =
    saveDraft.isPending || isDirty
      ? "saving"
      : saveDraft.isError
        ? "error"
        : saveDraft.isSuccess
          ? "saved"
          : "idle";
  const saveState = worstSaveState([titleState, summaryState, draftState]);

  return (
    <div>
      <div className="mb-6 flex items-center justify-between gap-3">
        <div className="flex items-center gap-2 text-neutral-500 text-xs">
          <Clapperboard className="size-3.5" />
          <span>
            {format ? `${format.emoji} ${format.shorthand}` : script.format} · Scene {scene.ordinal}{" "}
            · <span className="capitalize">{scene.status}</span>
            {pages !== null && (
              <span title="Estimated screenplay pages (~1 minute of screen time per page)">
                {" "}
                · ≈ {pages} {pages === 1 ? "page" : "pages"}
              </span>
            )}
          </span>
        </div>
        <div className="flex items-center gap-3">
          <SaveBadge state={saveState} />
          <button
            className="rounded-full border border-black/10 bg-white/60 px-3 py-1 text-neutral-700 text-xs hover:bg-white/90 disabled:opacity-50 dark:border-white/10 dark:bg-white/5 dark:text-neutral-300"
            disabled={setStatus.isPending || (scene.status !== "drafted" && !hasDraftContent)}
            onClick={() => setStatus.mutate(scene.status === "drafted" ? "drafting" : "drafted")}
            type="button"
          >
            {scene.status === "drafted" ? "Back to drafting" : "Mark as drafted"}
          </button>
        </div>
      </div>

      <input
        autoComplete="off"
        className="w-full bg-transparent font-serif text-3xl tracking-tight outline-none placeholder:text-neutral-400"
        id="scene-title"
        name="scene-title"
        onChange={(e) => setTitle(e.target.value)}
        placeholder={`Untitled scene ${scene.ordinal}`}
        value={title}
      />

      <input
        autoComplete="off"
        className="mt-2 w-full bg-transparent text-neutral-600 text-sm outline-none placeholder:text-neutral-400 dark:text-neutral-400"
        id="scene-summary"
        name="scene-summary"
        onChange={(e) => setSummary(e.target.value)}
        placeholder="One-line summary of what this scene must accomplish"
        value={summary}
      />

      <div className="mt-6 min-h-[60vh] rounded-2xl bg-white/70 py-5 ring-1 ring-black/5 dark:bg-neutral-900/70 dark:ring-white/5">
        <BlockNoteView
          editor={editor}
          theme={darkMode ? "dark" : "light"}
          onChange={() => {
            setIsDirty(true);
            if (pendingSave.current) window.clearTimeout(pendingSave.current);
            pendingSave.current = window.setTimeout(() => {
              pendingSave.current = undefined;
              saveDraft.mutate();
            }, 1000);
          }}
        />
      </div>
    </div>
  );
}

// Only trust persisted draft_json if it looks like a BlockNote document, so a
// bad payload can never keep the editor from opening (markdown is the
// fallback).
function looksLikeBlocks(value: unknown): boolean {
  return (
    Array.isArray(value) &&
    value.length > 0 &&
    value.every(
      (block) =>
        typeof block === "object" &&
        block !== null &&
        typeof (block as { type?: unknown }).type === "string",
    )
  );
}

function worstSaveState(states: SaveState[]): SaveState {
  if (states.includes("error")) return "error";
  if (states.includes("saving")) return "saving";
  if (states.includes("saved")) return "saved";
  return "idle";
}

function SaveBadge({ state }: { state: SaveState }) {
  if (state === "idle") return null;
  const label = state === "saving" ? "Saving…" : state === "saved" ? "Saved" : "Save failed";
  const tone =
    state === "error"
      ? "text-red-500"
      : state === "saved"
        ? "text-emerald-600 dark:text-emerald-400"
        : "text-neutral-500";
  return <span className={`text-xs ${tone}`}>{label}</span>;
}
