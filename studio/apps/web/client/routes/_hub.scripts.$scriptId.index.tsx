import { getScriptFormat } from "@/shared/script-formats";
import { useQuery } from "@tanstack/react-query";
import { Link, createFileRoute } from "@tanstack/react-router";
import { CheckCircle2, Clapperboard, PenLine, Settings2, Sparkles } from "lucide-react";
import { ScriptShell } from "../components/studio/ScriptShell";
import { type ScriptScene, api, queryKeys } from "../lib/api";

export const Route = createFileRoute("/_hub/scripts/$scriptId/")({ component: ScriptWorkspace });

function ScriptWorkspace() {
  const { scriptId } = Route.useParams();
  const script = useQuery({
    queryKey: queryKeys.script(scriptId),
    queryFn: () => api.getScript(scriptId),
  });
  const scenes = useQuery({
    queryKey: queryKeys.scriptScenes(scriptId),
    queryFn: () => api.listScriptScenes(scriptId),
  });

  const format = script.data ? getScriptFormat(script.data.format) : undefined;
  const structureLabel = format?.structures.find((s) => s.id === script.data?.structure)?.label;

  return (
    <ScriptShell
      current="scenes"
      scriptId={scriptId}
      title={script.data?.title ?? "Untitled script"}
    >
      {script.isLoading ? (
        <p className="text-neutral-500">Loading…</p>
      ) : !script.data || !format ? (
        <p className="text-neutral-500">Script not found.</p>
      ) : (
        <>
          <div className="mb-8 flex items-start justify-between gap-4">
            <div>
              <div className="flex items-center gap-2 text-neutral-500 text-sm">
                <Clapperboard className="size-4" />
                <span>
                  {format.emoji} {format.shorthand}
                  {structureLabel ? ` · ${structureLabel}` : ""}
                </span>
              </div>
              <h1 className="mt-1 font-serif text-3xl tracking-tight">{script.data.title}</h1>
              <p className="mt-2 max-w-2xl text-neutral-500">{script.data.logline}</p>
              {(scenes.data?.items ?? []).length > 0 && (
                <p className="mt-2 text-neutral-500 text-sm">
                  {sceneProgress(scenes.data?.items ?? [])}
                </p>
              )}
            </div>
            <Link
              className="flex shrink-0 items-center gap-2 rounded-full border border-black/10 bg-white/60 px-4 py-2 font-medium text-neutral-700 text-sm hover:bg-white/90 dark:border-white/10 dark:bg-white/5 dark:text-neutral-300"
              params={{ scriptId }}
              to="/scripts/$scriptId/structure"
            >
              <Settings2 className="size-4" />
              {script.data.structure ? "Adjust structure" : "Plan the scenes"}
            </Link>
          </div>

          {(scenes.data?.items ?? []).length === 0 ? (
            <div className="rounded-2xl border border-neutral-300 border-dashed bg-white/40 p-10 text-center text-neutral-500 dark:border-white/15 dark:bg-white/5">
              <Sparkles className="mx-auto mb-2 size-5" />
              <p>
                No scenes planned yet.{" "}
                <Link
                  className="underline hover:text-neutral-700 dark:hover:text-neutral-300"
                  params={{ scriptId }}
                  to="/scripts/$scriptId/structure"
                >
                  Pick a structure and planning threshold
                </Link>{" "}
                to lay out the script.
              </p>
            </div>
          ) : (
            <ul className="grid gap-2">
              {(scenes.data?.items ?? []).map((s) => (
                <SceneRow key={s.id} scene={s} scriptId={scriptId} />
              ))}
            </ul>
          )}
        </>
      )}
    </ScriptShell>
  );
}

const STATUS_CHIP: Record<ScriptScene["status"], string> = {
  planned: "bg-neutral-200/70 text-neutral-600 dark:bg-white/10 dark:text-neutral-300",
  drafting: "bg-amber-500/15 text-amber-700 dark:text-amber-400",
  drafted: "bg-sky-500/15 text-sky-700 dark:text-sky-400",
};

function sceneProgress(items: ScriptScene[]): string {
  const parts = [`${items.length} ${items.length === 1 ? "scene" : "scenes"}`];
  for (const status of ["drafting", "drafted"] as const) {
    const n = items.filter((s) => s.status === status).length;
    if (n > 0) parts.push(`${n} ${status}`);
  }
  return parts.join(" · ");
}

function SceneRow({ scriptId, scene }: { scriptId: string; scene: ScriptScene }) {
  const hasDraft = scene.draft_md.trim().length > 0;

  return (
    <li className="flex min-w-0 items-center justify-between gap-3 rounded-2xl bg-white/80 p-4 ring-1 ring-black/5 transition hover:shadow-md dark:bg-neutral-900/80 dark:ring-white/5">
      <Link
        className="group flex min-w-0 flex-1 items-center gap-3"
        params={{ scriptId, sceneId: scene.id }}
        to="/scripts/$scriptId/scenes/$sceneId"
      >
        <div className="flex size-8 shrink-0 items-center justify-center rounded-full bg-neutral-100 font-medium text-neutral-600 text-sm dark:bg-white/10 dark:text-neutral-300">
          {scene.ordinal}
        </div>
        <div className="min-w-0">
          <div className="truncate font-serif text-lg group-hover:underline">
            {scene.title || `Untitled scene ${scene.ordinal}`}
          </div>
          <div className="mt-0.5 flex min-w-0 items-center gap-2">
            <span
              className={`shrink-0 rounded-full px-2 py-0.5 text-[11px] capitalize ${STATUS_CHIP[scene.status]}`}
            >
              {scene.status}
            </span>
            {scene.summary.trim() ? (
              <span className="min-w-0 truncate text-neutral-500 text-xs">{scene.summary}</span>
            ) : null}
          </div>
        </div>
      </Link>
      <div className="flex shrink-0 items-center gap-2">
        {scene.status === "drafted" ? (
          <span className="flex items-center gap-1.5 rounded-full bg-sky-500/10 px-3 py-1.5 text-sky-700 text-xs dark:text-sky-400">
            <CheckCircle2 className="size-3.5" />
            Drafted
          </span>
        ) : hasDraft ? (
          <Link
            className="flex items-center gap-1.5 rounded-full bg-neutral-100 px-3 py-1.5 font-medium text-neutral-600 text-xs hover:bg-neutral-200 dark:bg-white/10 dark:text-neutral-300 dark:hover:bg-white/20"
            params={{ scriptId, sceneId: scene.id }}
            to="/scripts/$scriptId/scenes/$sceneId"
          >
            Open
          </Link>
        ) : (
          <Link
            className="flex items-center gap-1.5 rounded-full bg-neutral-100 px-3 py-1.5 font-medium text-neutral-600 text-xs hover:bg-neutral-200 dark:bg-white/10 dark:text-neutral-300 dark:hover:bg-white/20"
            params={{ scriptId, sceneId: scene.id }}
            to="/scripts/$scriptId/scenes/$sceneId"
          >
            <PenLine className="size-3.5" />
            Write
          </Link>
        )}
      </div>
    </li>
  );
}
