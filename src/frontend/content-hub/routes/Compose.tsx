// Book compose wizard — ported from
// studio/apps/web/client/routes/_hub.compose.tsx.
//
// Changes vs the studio source:
//   - File-based route (`createFileRoute("/_hub/compose")`) → plain component
//     (`Compose`), mounted by spooool's code-based router under the /studio
//     layout (router.tsx). The route is registered as /studio/compose.
//   - Component imports point at the ported copies under ../components and
//     ../lib/api.
//   - On successful create the studio navigated to the typed route
//     `/$projectId`; here we redirect to the spooool-absolute `/studio/$id`.
//     That detail route lands in a later PR (404s until then) — the
//     create+redirect itself works. `/studio/:id` isn't in spooool's typed
//     route tree yet, so we navigate with an untyped target (see studioNavigate).
import { useMutation } from '@tanstack/react-query';
import { useNavigate } from '@tanstack/react-router';
import { Plus, Wand2 } from 'lucide-react';
import { useEffect, useMemo, useRef, useState } from 'react';
import { DynamicIslandTOC } from '../components/dynamic-toc';
import { ChoiceCard, Step, ToggleChip } from '../components/wizard';
import { api } from '../lib/api';
import { scrollToStep } from '../lib/scroll-to-step';

type StepKey = 'title' | 'genre' | 'type' | 'logline' | 'audience' | 'voice' | 'review';

const STEPS: { id: StepKey; label: string }[] = [
  { id: 'title', label: 'Working title' },
  { id: 'genre', label: 'Genre' },
  { id: 'type', label: 'Fiction or nonfiction' },
  { id: 'logline', label: 'Your story in one sentence' },
  { id: 'audience', label: 'Who is this for' },
  { id: 'voice', label: 'Voice & tone' },
  { id: 'review', label: 'Review & start' },
];

const GENRE_OPTIONS = [
  'Literary Fiction',
  'Fantasy',
  'Sci-Fi',
  'Mystery & Thriller',
  'Horror',
  'Romance',
  'Historical Fiction',
  'Young Adult',
  'Memoir',
  'Self-Help',
  'Business',
  'True Crime',
];

const AUDIENCE_OPTIONS = [
  'Adults',
  'Young Adults (13–18)',
  'Middle Grade (8–12)',
  'Business readers',
  'Literary readers',
  'Genre fans',
];

const VOICE_OPTIONS = [
  'Spare & minimalist',
  'Lyrical',
  'Dark & atmospheric',
  'Witty & sharp',
  'Conversational',
  'Intimate',
  'Formal',
  'Satirical',
  'Propulsive',
];

function toggle(arr: string[], val: string): string[] {
  return arr.includes(val) ? arr.filter((v) => v !== val) : [...arr, val];
}

export function Compose() {
  const nav = useNavigate();
  const containerRef = useRef<HTMLDivElement | null>(null);
  const [container, setContainer] = useState<HTMLDivElement | null>(null);

  const [title, setTitle] = useState('');
  const [type, setType] = useState<'fiction' | 'nonfiction'>('fiction');
  const [genre, setGenre] = useState<string[]>([]);
  const [logline, setLogline] = useState('');
  const [audience, setAudience] = useState<string[]>([]);
  const [voice, setVoice] = useState<string[]>([]);
  const [genError, setGenError] = useState<string | null>(null);

  useEffect(() => {
    setContainer(containerRef.current);
  }, []);

  const composed = useMemo(() => logline.trim(), [logline]);

  const generate = useMutation({
    mutationFn: () => api.generateLogline({ title: title.trim() || undefined, type }),
    onSuccess: ({ logline: generated }) => {
      setLogline(generated);
      setGenError(null);
    },
    onError: (err: unknown) => {
      setGenError(err instanceof Error ? err.message : 'Generation failed');
    },
  });

  const canGenerate = !generate.isPending;

  const create = useMutation({
    mutationFn: api.createProject,
    onSuccess: ({ id }) => {
      // /studio/:id detail route lands in a later PR; navigate untyped so this
      // compiles against the current route tree. The logline is carried as a
      // search param, mirroring the studio source. Cast through `unknown`
      // because the target route isn't in the typed tree yet.
      void nav({
        to: `/studio/${id}`,
        search: { logline: composed },
      } as unknown as Parameters<typeof nav>[0]);
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
    if (el && containerRef.current) scrollToStep(containerRef.current, el);
  };

  const canSubmit = title.trim().length > 0 && composed.length > 8;

  return (
    <div
      className="h-[calc(100vh-3.5rem)] snap-y snap-mandatory overflow-y-scroll bg-[#efece2] text-neutral-900 dark:bg-[#1a1a1a] dark:text-neutral-100"
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
        title="What's the working title?"
        subtitle="You can change it any time."
      >
        <input
          autoComplete="off"
          className="w-full bg-transparent font-serif text-3xl outline-none placeholder:text-neutral-400"
          id="compose-title"
          name="compose-title"
          onChange={(e) => setTitle(e.target.value)}
          autoFocus
          placeholder="Untitled book"
          value={title}
        />
      </Step>

      <Step
        anchorId="step-genre"
        index={2}
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
        anchorId="step-type"
        index={3}
        total={STEPS.length}
        onNext={() => goNext('type')}
        canAdvance
        title="Fiction or nonfiction?"
        subtitle="Sets the framework Book Cook proposes next."
      >
        <div className="flex gap-3">
          <ChoiceCard
            active={type === 'fiction'}
            onClick={() => setType('fiction')}
            title="Fiction"
            subtitle="Story, characters, scenes"
          />
          <ChoiceCard
            active={type === 'nonfiction'}
            onClick={() => setType('nonfiction')}
            title="Nonfiction"
            subtitle="Argument, evidence, chapters"
          />
        </div>
      </Step>

      <Step
        anchorId="step-logline"
        index={4}
        total={STEPS.length}
        onNext={() => goNext('logline')}
        canAdvance={composed.length > 8}
        title="Your story, in one sentence."
        subtitle="Generate a logline — or write your own below."
      >
        <div className="mb-5 flex items-center gap-3">
          <div className="rounded-xl bg-neutral-100/60 px-3 py-2 text-neutral-600 text-sm ring-1 ring-black/5 dark:bg-white/5 dark:text-neutral-400 dark:ring-white/10">
            Protagonist
          </div>
          <Plus className="size-3.5 shrink-0 text-neutral-400" />
          <div className="rounded-xl bg-neutral-100/60 px-3 py-2 text-neutral-600 text-sm ring-1 ring-black/5 dark:bg-white/5 dark:text-neutral-400 dark:ring-white/10">
            Conflict
          </div>
          <Plus className="size-3.5 shrink-0 text-neutral-400" />
          <div className="rounded-xl bg-neutral-100/60 px-3 py-2 text-neutral-600 text-sm ring-1 ring-black/5 dark:bg-white/5 dark:text-neutral-400 dark:ring-white/10">
            Stakes
          </div>
        </div>
        <div className="mb-3 flex items-center gap-3">
          <button
            className="flex items-center gap-2 rounded-full bg-neutral-950/90 px-3 py-1.5 text-neutral-200 text-sm hover:bg-neutral-800 disabled:opacity-50"
            disabled={!canGenerate}
            onClick={() => generate.mutate()}
            type="button"
          >
            <Wand2 className="size-3.5" />
            {generate.isPending ? 'Generating…' : 'Generate logline'}
          </button>
          {genError && <span className="text-red-500 text-xs">{genError}</span>}
        </div>
        <textarea
          className="w-full resize-none bg-transparent font-serif text-2xl leading-relaxed outline-none placeholder:text-neutral-400"
          id="compose-logline"
          name="compose-logline"
          onChange={(e) => setLogline(e.target.value)}
          placeholder="A reluctant cartographer must map a city that rearranges itself each night, before home erases her too."
          rows={4}
          value={logline}
        />
      </Step>

      <Step
        anchorId="step-audience"
        index={5}
        total={STEPS.length}
        onNext={() => goNext('audience')}
        canAdvance
        title="Who is this for?"
        subtitle="Pick any that apply. Skip if you're not sure yet."
      >
        <div className="flex flex-wrap gap-2">
          {AUDIENCE_OPTIONS.map((a) => (
            <ToggleChip
              key={a}
              label={a}
              active={audience.includes(a)}
              onClick={() => setAudience((prev) => toggle(prev, a))}
            />
          ))}
        </div>
      </Step>

      <Step
        anchorId="step-voice"
        index={6}
        total={STEPS.length}
        onNext={() => goNext('voice')}
        canAdvance
        title="Voice & tone"
        subtitle="Pick any that fit. Browse the voice library at Post Pilot."
      >
        <div className="flex flex-wrap gap-2">
          {VOICE_OPTIONS.map((v) => (
            <ToggleChip
              key={v}
              label={v}
              active={voice.includes(v)}
              onClick={() => setVoice((prev) => toggle(prev, v))}
            />
          ))}
        </div>
        <p className="mt-4 text-neutral-500 text-sm">
          Looking for more?{' '}
          <a
            className="underline hover:text-neutral-700 dark:hover:text-neutral-300"
            href="https://postpilot.cc"
            rel="noopener noreferrer"
            target="_blank"
          >
            Browse voices on Post Pilot
          </a>
        </p>
      </Step>

      <Step
        anchorId="step-review"
        index={7}
        total={STEPS.length}
        onNext={() =>
          create.mutate({
            title: title.trim(),
            type,
            genre: genre.length > 0 ? genre.join(', ') : undefined,
            logline: composed,
            audience,
            voice_styles: voice,
          })
        }
        canAdvance={canSubmit}
        title="Review & start"
        subtitle="You can edit everything inside the canvas."
        ctaLabel={create.isPending ? 'Creating…' : 'Open canvas'}
      >
        <div className="space-y-3 rounded-2xl bg-white/70 p-5 ring-1 ring-black/5 dark:bg-neutral-900/70 dark:ring-white/5">
          <ReviewRow label="Title" value={title || '—'} />
          {genre.length > 0 && <ReviewRow label="Genre" value={genre.join(' · ')} />}
          <ReviewRow label="Type" value={type} />
          <ReviewRow label="Logline" value={composed || '—'} />
          {audience.length > 0 && <ReviewRow label="Audience" value={audience.join(' · ')} />}
          {voice.length > 0 && <ReviewRow label="Voice" value={voice.join(' · ')} />}
        </div>
        {create.isError && (
          <p className="mt-3 text-red-500 text-sm">
            {create.error instanceof Error ? create.error.message : 'Could not create the book'}
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
