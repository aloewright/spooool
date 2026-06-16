// Script structure picker — choose a structure + planned-scene count, then plan
// the scenes. Ported from
// studio/apps/web/client/routes/_hub.scripts.$scriptId.structure.tsx.
//
// Changes vs the studio source:
//   - File route (createFileRoute("/_hub/scripts/$scriptId/structure")) → plain
//     component (ScriptStructure), mounted by spooool's code-based router at
//     /studio/scripts/$scriptId/structure (router.tsx).
//   - Params read via useParams({ strict: false }).
//   - Post-plan redirect navigates to the typed, registered
//     /studio/scripts/$scriptId workspace.
//   - Component/lib/shared imports point at the ported copies.
import type { JSX } from 'react';
import { getScriptFormat, planScenesForStructure } from '../shared/script-formats';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useNavigate, useParams } from '@tanstack/react-router';
import { ArrowRight, Minus, Plus, Sparkles } from 'lucide-react';
import { useEffect, useState } from 'react';
import { ScriptShell } from '../components/studio/ScriptShell';
import { api, queryKeys } from '../lib/api';

export function ScriptStructure(): JSX.Element {
  const { scriptId = '' } = useParams({ strict: false });
  const nav = useNavigate();
  const qc = useQueryClient();
  const script = useQuery({
    queryKey: queryKeys.script(scriptId),
    queryFn: () => api.getScript(scriptId),
  });

  const format = script.data ? getScriptFormat(script.data.format) : undefined;
  const [structure, setStructure] = useState<string | null>(null);
  const [count, setCount] = useState<number | null>(null);

  useEffect(() => {
    if (!script.data || !format) return;
    setStructure((prev) => prev ?? script.data.structure ?? null);
    setCount((prev) => prev ?? Math.max(script.data.planned_scenes, format.defaultScenes));
  }, [script.data, format]);

  const plan = useMutation({
    mutationFn: (input: { structure: string; planned_scenes: number }) =>
      api.planScript(scriptId, input),
    onSuccess: () =>
      Promise.all([
        qc.invalidateQueries({ queryKey: queryKeys.script(scriptId) }),
        qc.invalidateQueries({ queryKey: queryKeys.scriptScenes(scriptId) }),
      ]).then(() => nav({ to: '/studio/scripts/$scriptId', params: { scriptId } })),
  });

  if (script.isLoading) {
    return (
      <ScriptShell current="structure" maxWidth="max-w-3xl" scriptId={scriptId} title="Structure">
        <p className="text-neutral-500">Loading…</p>
      </ScriptShell>
    );
  }
  if (!script.data || !format) {
    return (
      <ScriptShell current="structure" maxWidth="max-w-3xl" scriptId={scriptId} title="Structure">
        <p className="text-neutral-500">Script not found.</p>
      </ScriptShell>
    );
  }

  const scenes = count ?? format.defaultScenes;
  const canSave = !!structure && scenes >= format.minScenes && !plan.isPending;
  const structureDef = format.structures.find((s) => s.id === structure);
  const beatPlan = structureDef?.beats ? planScenesForStructure(structureDef, scenes) : [];

  function selectStructure(id: string) {
    setStructure(id);
    // Structures with narrative beats default to one scene per beat.
    const beats = format?.structures.find((s) => s.id === id)?.beats;
    if (beats && format) {
      setCount(Math.min(52, Math.max(format.minScenes, beats.length)));
    }
  }

  return (
    <ScriptShell
      current="structure"
      maxWidth="max-w-3xl"
      scriptId={scriptId}
      title={script.data.title}
    >
      <div>
        <div className="mb-8">
          <div className="flex items-center gap-2 text-neutral-500 text-sm">
            <Sparkles className="size-4" />
            <span>
              {format.emoji} {format.shorthand}
            </span>
          </div>
          <h1 className="mt-1 font-serif text-3xl tracking-tight">Structure the script</h1>
          <p className="mt-2 text-neutral-500">
            Pick how {script.data.title} is built, then set how many scenes to plan at a time.
          </p>
        </div>

        <h2 className="mb-3 font-serif text-xl tracking-tight">Script structure</h2>
        <div className="grid gap-3 sm:grid-cols-3">
          {format.structures.map((s) => (
            <button
              className={`rounded-2xl border p-4 text-left transition ${
                structure === s.id
                  ? 'border-emerald-500 bg-emerald-500/10'
                  : 'border-black/10 bg-white/60 hover:bg-white/90 dark:border-white/10 dark:bg-white/5'
              }`}
              key={s.id}
              onClick={() => selectStructure(s.id)}
              type="button"
            >
              <div className="font-serif text-lg">{s.label}</div>
              <div className="mt-1 text-neutral-500 text-sm">{s.description}</div>
              {s.beats && (
                <div className="mt-2 text-[11px] text-neutral-400">{s.beats.length} beats</div>
              )}
            </button>
          ))}
        </div>

        <h2 className="mt-10 mb-3 font-serif text-xl tracking-tight">Planning threshold</h2>
        <p className="mb-4 text-neutral-500 text-sm">{format.planningNote}</p>
        <div className="flex items-center gap-3">
          <button
            aria-label="Fewer scenes"
            className="flex size-9 items-center justify-center rounded-full border border-black/10 bg-white/60 hover:bg-white/90 disabled:opacity-40 dark:border-white/10 dark:bg-white/5"
            disabled={scenes <= format.minScenes}
            onClick={() => setCount(Math.max(format.minScenes, scenes - 1))}
            type="button"
          >
            <Minus className="size-4" />
          </button>
          <div className="w-28 text-center">
            <div className="font-serif text-3xl">{scenes}</div>
            <div className="text-neutral-500 text-xs">
              scene{scenes === 1 ? '' : 's'} per script
            </div>
          </div>
          <button
            aria-label="More scenes"
            className="flex size-9 items-center justify-center rounded-full border border-black/10 bg-white/60 hover:bg-white/90 disabled:opacity-40 dark:border-white/10 dark:bg-white/5"
            disabled={scenes >= 52}
            onClick={() => setCount(Math.min(52, scenes + 1))}
            type="button"
          >
            <Plus className="size-4" />
          </button>
          <span className="text-neutral-400 text-xs">
            minimum {format.minScenes} for {format.shorthand.toLowerCase()}
          </span>
        </div>

        {beatPlan.length > 0 && (
          <div className="mt-8">
            <h2 className="mb-1 font-serif text-xl tracking-tight">Scene plan</h2>
            <p className="mb-3 text-neutral-500 text-sm">
              {structureDef?.label} mapped onto {scenes} scenes — each slot becomes a planned scene
              you can rename and draft.
            </p>
            <ol className="max-h-72 space-y-1 overflow-y-auto rounded-2xl bg-white/60 p-4 ring-1 ring-black/5 dark:bg-neutral-900/60 dark:ring-white/5">
              {beatPlan.map((beat, i) => (
                <li
                  className="flex items-baseline gap-3 text-sm"
                  key={`${beat.title}-${
                    // biome-ignore lint/suspicious/noArrayIndexKey: plan entries can repeat titles
                    i
                  }`}
                >
                  <span className="w-6 shrink-0 text-right text-neutral-400 tabular-nums">
                    {i + 1}
                  </span>
                  <span className="font-medium">{beat.title}</span>
                </li>
              ))}
            </ol>
          </div>
        )}

        <div className="mt-10 flex items-center gap-3">
          <button
            className="flex items-center gap-2 rounded-full bg-emerald-600 px-5 py-2.5 font-medium text-sm text-white shadow hover:bg-emerald-500 disabled:opacity-40"
            disabled={!canSave}
            onClick={() => structure && plan.mutate({ structure, planned_scenes: scenes })}
            type="button"
          >
            {plan.isPending ? 'Planning…' : 'Plan scenes'}
            <ArrowRight className="size-3.5" />
          </button>
          {plan.isError && (
            <span className="text-red-500 text-sm">
              {plan.error instanceof Error ? plan.error.message : 'Could not save the plan'}
            </span>
          )}
        </div>
      </div>
    </ScriptShell>
  );
}
