// Script compose wizard — ported from
// studio/apps/web/client/routes/_hub.compose-script.tsx.
//
// Changes vs the studio source:
//   - File-based route (`createFileRoute("/_hub/compose-script")`) → plain
//     component (`ComposeScript`), registered as /studio/compose-script under
//     the /studio layout (router.tsx).
//   - `@/shared/script-formats` → `../shared/script-formats`; component + api
//     imports point at the ported copies.
//   - On create the studio navigated to `/scripts/$scriptId/structure`; here
//     we redirect to `/studio/scripts/$id/structure` (detail route lands in a
//     later PR — 404s until then; create+redirect works). It isn't in the
//     typed route tree yet, so we navigate with an untyped target.
import { useMutation } from '@tanstack/react-query';
import { useNavigate } from '@tanstack/react-router';
import { useEffect, useMemo, useRef, useState } from 'react';
import { DynamicIslandTOC } from '../components/dynamic-toc';
import { Step, ToggleChip } from '../components/wizard';
import { api } from '../lib/api';
import { SCRIPT_FORMATS, getScriptFormat } from '../shared/script-formats';
import type { ScriptFormatId } from '../shared/script-formats';

type StepKey = 'title' | 'format' | 'premise' | 'genre' | 'review';

const STEPS: { id: StepKey; label: string }[] = [
  { id: 'title', label: 'Working title' },
  { id: 'format', label: 'Format' },
  { id: 'premise', label: 'Your premise in one line' },
  { id: 'genre', label: 'Genre' },
  { id: 'review', label: 'Review & start' },
];

const GENRE_OPTIONS = [
  'Drama',
  'Comedy',
  'Thriller',
  'Sci-Fi',
  'Horror',
  'Romance',
  'Action',
  'Crime',
  'Fantasy',
  'Documentary',
];

function toggle(arr: string[], val: string): string[] {
  return arr.includes(val) ? arr.filter((v) => v !== val) : [...arr, val];
}

export function ComposeScript() {
  const nav = useNavigate();
  const containerRef = useRef<HTMLDivElement | null>(null);
  const [container, setContainer] = useState<HTMLDivElement | null>(null);

  const [title, setTitle] = useState('');
  const [format, setFormat] = useState<ScriptFormatId | null>(null);
  const [premise, setPremise] = useState('');
  const [genre, setGenre] = useState<string[]>([]);

  useEffect(() => {
    setContainer(containerRef.current);
  }, []);

  const selectedFormat = format ? getScriptFormat(format) : undefined;
  const composed = useMemo(() => premise.trim(), [premise]);

  const create = useMutation({
    mutationFn: api.createScript,
    onSuccess: ({ id }) => {
      void nav({ to: `/studio/scripts/${id}/structure` } as unknown as Parameters<typeof nav>[0]);
    },
  });

  const goNext = (id: StepKey) => {
    const idx = STEPS.findIndex((s) => s.id === id);
    if (idx === -1) return;
    const nextIdx = Math.min(idx + 1, STEPS.length - 1);
    if (nextIdx === idx) return;
    const next = STEPS[nextIdx];
    window.history.pushState(null, '', `#step-${next.id}`);
    const el = document.getElementById(`step-${next.id}`);
    if (el && containerRef.current) {
      const top =
        el.getBoundingClientRect().top -
        containerRef.current.getBoundingClientRect().top +
        containerRef.current.scrollTop -
        40;
      containerRef.current.scrollTo({ top, behavior: 'smooth' });
    }
  };

  const canSubmit = title.trim().length > 0 && !!format && composed.length >= 8;

  return (
    <div
      className="script-surface h-[calc(100vh-3.5rem)] snap-y snap-mandatory overflow-y-scroll bg-[#efece2] text-neutral-900 dark:bg-[#1a1a1a] dark:text-neutral-100"
      ref={containerRef}
    >
      <DynamicIslandTOC scrollContainer={container} selector="[data-toc]" />

      <Step
        active
        anchorId="step-title"
        index={1}
        total={STEPS.length}
        onNext={() => goNext('title')}
        canAdvance={title.trim().length > 0}
        title="What's your script called?"
        subtitle="You can change it any time."
      >
        <input
          autoComplete="off"
          className="w-full bg-transparent font-serif text-3xl outline-none placeholder:text-neutral-400"
          id="compose-script-title"
          name="compose-script-title"
          onChange={(e) => setTitle(e.target.value)}
          autoFocus
          placeholder="Untitled script"
          value={title}
        />
      </Step>

      <Step
        anchorId="step-format"
        index={2}
        total={STEPS.length}
        onNext={() => goNext('format')}
        canAdvance={!!format}
        title="What format will it take?"
        subtitle="Pick one — it shapes the structures and planning Book Cook proposes next."
      >
        <div className="grid gap-2 sm:grid-cols-2">
          {SCRIPT_FORMATS.map((f) => (
            <button
              className={`rounded-2xl border p-4 text-left transition ${
                format === f.id
                  ? 'border-emerald-500 bg-emerald-500/10'
                  : 'border-black/10 bg-white/60 hover:bg-white/90 dark:border-white/10 dark:bg-white/5'
              }`}
              key={f.id}
              onClick={() => setFormat(f.id)}
              type="button"
            >
              <div className="font-serif text-lg">
                {f.emoji} {f.shorthand}
              </div>
              <div className="mt-1 text-neutral-500 text-sm">{f.description}</div>
            </button>
          ))}
        </div>
      </Step>

      <Step
        anchorId="step-premise"
        index={3}
        total={STEPS.length}
        onNext={() => goNext('premise')}
        canAdvance={composed.length >= 8}
        title="Your premise, in one line."
        subtitle="A rough logline is fine — who wants what, and what stands in the way?"
      >
        <textarea
          className="w-full resize-none bg-transparent font-serif text-2xl leading-relaxed outline-none placeholder:text-neutral-400"
          id="compose-script-premise"
          name="compose-script-premise"
          onChange={(e) => setPremise(e.target.value)}
          placeholder="A burned-out air-traffic controller must talk her estranged brother's plane through a storm that grounded every other flight."
          rows={3}
          value={premise}
        />
      </Step>

      <Step
        anchorId="step-genre"
        index={4}
        total={STEPS.length}
        onNext={() => goNext('genre')}
        canAdvance
        title="What's the genre?"
        subtitle="Pick as many as apply. You can change this later."
      >
        <div className="flex flex-wrap gap-2">
          {GENRE_OPTIONS.map((g) => (
            <ToggleChip
              key={g}
              label={g}
              active={genre.includes(g)}
              onClick={() => setGenre((prev) => toggle(prev, g))}
            />
          ))}
        </div>
      </Step>

      <Step
        anchorId="step-review"
        index={5}
        total={STEPS.length}
        onNext={() =>
          format &&
          create.mutate({
            title: title.trim(),
            format,
            logline: composed,
            genre: genre.length > 0 ? genre.join(', ') : undefined,
          })
        }
        canAdvance={canSubmit && !create.isPending}
        title="Review & start"
        subtitle="Next you'll pick a structure and how many scenes to plan at a time."
        ctaLabel={create.isPending ? 'Creating…' : 'Plan the scenes'}
      >
        <div className="space-y-3 rounded-2xl bg-white/70 p-5 ring-1 ring-black/5 dark:bg-neutral-900/70 dark:ring-white/5">
          <ReviewRow label="Title" value={title || '—'} />
          <ReviewRow
            label="Format"
            value={selectedFormat ? `${selectedFormat.emoji} ${selectedFormat.shorthand}` : '—'}
          />
          <ReviewRow label="Premise" value={composed || '—'} />
          {genre.length > 0 && <ReviewRow label="Genre" value={genre.join(' · ')} />}
        </div>
        {create.isError && (
          <p className="mt-3 text-red-500 text-sm">
            {create.error instanceof Error ? create.error.message : 'Could not create the script'}
          </p>
        )}
      </Step>
    </div>
  );
}

function ReviewRow({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex items-start gap-3">
      <div className="w-24 shrink-0 text-[11px] text-neutral-500 uppercase tracking-wide">
        {label}
      </div>
      <div className="font-serif text-base">{value}</div>
    </div>
  );
}
