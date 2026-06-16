// Blog compose wizard — ported from
// studio/apps/web/client/routes/_hub.compose-blog.tsx.
//
// Changes vs the studio source:
//   - File-based route (`createFileRoute("/_hub/compose-blog")`) → plain
//     component (`ComposeBlog`), registered as /studio/compose-blog under the
//     /studio layout (router.tsx).
//   - `@/shared/blog-formats` → `../shared/blog-formats`; component + api
//     imports point at the ported copies.
//   - On create the studio navigated to `/blogs/$blogId/structure`; here we
//     redirect to `/studio/blogs/$id/structure` (that detail route lands in a
//     later PR — 404s until then; the create+redirect itself works). It isn't
//     in the typed route tree yet, so we navigate with an untyped target.
import { useMutation } from '@tanstack/react-query';
import { useNavigate } from '@tanstack/react-router';
import { FileUp, Link2, Wand2, X } from 'lucide-react';
import { useEffect, useMemo, useRef, useState } from 'react';
import { DynamicIslandTOC } from '../components/dynamic-toc';
import { Step, ToggleChip } from '../components/wizard';
import { type BlogVoiceUpload, api } from '../lib/api';
import { BLOG_FORMATS, getBlogFormat } from '../shared/blog-formats';
import type { BlogFormatId } from '../shared/blog-formats';

type StepKey = 'title' | 'format' | 'about' | 'audience' | 'voice' | 'rules' | 'review';

const STEPS: { id: StepKey; label: string }[] = [
  { id: 'title', label: 'Working title' },
  { id: 'format', label: 'Format' },
  { id: 'about', label: 'Your blog in one line' },
  { id: 'audience', label: 'Who is this for' },
  { id: 'voice', label: 'Voice & tone' },
  { id: 'rules', label: 'DOs and DO NOTs' },
  { id: 'review', label: 'Review & start' },
];

const MAX_UPLOAD_CHARS = 40_000;
// The compose APIs accept at most five links and five uploads each.
const MAX_VOICE_SAMPLES = 5;

function toggle(arr: string[], val: string): string[] {
  return arr.includes(val) ? arr.filter((v) => v !== val) : [...arr, val];
}

function parseRules(text: string): string[] {
  return text
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line.length > 0)
    .slice(0, 20);
}

export function ComposeBlog() {
  const nav = useNavigate();
  const containerRef = useRef<HTMLDivElement | null>(null);
  const [container, setContainer] = useState<HTMLDivElement | null>(null);

  const [title, setTitle] = useState('');
  const [format, setFormat] = useState<BlogFormatId | null>(null);
  const [about, setAbout] = useState('');
  const [audience, setAudience] = useState<string[]>([]);
  const [voiceLinks, setVoiceLinks] = useState<string[]>([]);
  const [linkDraft, setLinkDraft] = useState('');
  const [voiceUploads, setVoiceUploads] = useState<BlogVoiceUpload[]>([]);
  const [pasteDraft, setPasteDraft] = useState('');
  const [profile, setProfile] = useState('');
  const [voiceError, setVoiceError] = useState<string | null>(null);
  const [dosText, setDosText] = useState('');
  const [dontsText, setDontsText] = useState('');

  useEffect(() => {
    setContainer(containerRef.current);
  }, []);

  const selectedFormat = format ? getBlogFormat(format) : undefined;
  const audienceOptions = selectedFormat?.audienceOptions ?? [];
  const composed = useMemo(() => about.trim(), [about]);
  const sampleCount = voiceLinks.length + voiceUploads.length;

  const extrapolate = useMutation({
    mutationFn: () => api.extrapolateBlogVoice({ links: voiceLinks, uploads: voiceUploads }),
    onSuccess: ({ profile_md }) => {
      setProfile(profile_md);
      setVoiceError(null);
    },
    onError: (err: unknown) => {
      setVoiceError(err instanceof Error ? err.message : 'Voice extrapolation failed');
    },
  });

  const create = useMutation({
    mutationFn: api.createBlog,
    onSuccess: ({ id }) => {
      void nav({ to: `/studio/blogs/${id}/structure` } as unknown as Parameters<typeof nav>[0]);
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

  function selectFormat(id: BlogFormatId) {
    setFormat(id);
    // Audience options are curated per format, so drop picks that no longer apply.
    const options = getBlogFormat(id)?.audienceOptions ?? [];
    setAudience((prev) => prev.filter((a) => options.includes(a)));
  }

  function addLink() {
    const candidate = linkDraft.trim();
    if (!candidate) return;
    if (voiceLinks.length >= MAX_VOICE_SAMPLES) {
      setVoiceError(`You can add up to ${MAX_VOICE_SAMPLES} links`);
      return;
    }
    try {
      new URL(candidate);
    } catch {
      setVoiceError("That doesn't look like a valid link");
      return;
    }
    if (!voiceLinks.includes(candidate)) setVoiceLinks((prev) => [...prev, candidate]);
    setLinkDraft('');
    setVoiceError(null);
  }

  async function addFiles(files: FileList | null) {
    if (!files) return;
    if (voiceUploads.length >= MAX_VOICE_SAMPLES) {
      setVoiceError(`You can add up to ${MAX_VOICE_SAMPLES} uploads`);
      return;
    }
    const next: BlogVoiceUpload[] = [];
    for (const file of Array.from(files).slice(0, MAX_VOICE_SAMPLES)) {
      const text = (await file.text()).slice(0, MAX_UPLOAD_CHARS);
      if (text.trim().length > 0) next.push({ name: file.name, text });
    }
    if (next.length > 0) {
      setVoiceUploads((prev) => [...prev, ...next].slice(0, MAX_VOICE_SAMPLES));
      setVoiceError(null);
    }
  }

  function addPaste() {
    const text = pasteDraft.trim().slice(0, MAX_UPLOAD_CHARS);
    if (!text) return;
    if (voiceUploads.length >= MAX_VOICE_SAMPLES) {
      setVoiceError(`You can add up to ${MAX_VOICE_SAMPLES} uploads`);
      return;
    }
    setVoiceUploads((prev) =>
      [...prev, { name: 'Pasted article', text }].slice(0, MAX_VOICE_SAMPLES),
    );
    setPasteDraft('');
    setVoiceError(null);
  }

  const canSubmit = title.trim().length > 0 && !!format && composed.length > 8 && sampleCount >= 1;

  return (
    <div
      className="blog-surface h-[calc(100vh-3.5rem)] snap-y snap-mandatory overflow-y-scroll bg-[#efece2] text-neutral-900 dark:bg-[#1a1a1a] dark:text-neutral-100"
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
        title="What's your blog called?"
        subtitle="You can change it any time."
      >
        <input
          autoComplete="off"
          className="w-full bg-transparent font-serif text-3xl outline-none placeholder:text-neutral-400"
          id="compose-blog-title"
          name="compose-blog-title"
          onChange={(e) => setTitle(e.target.value)}
          autoFocus
          placeholder="Untitled blog"
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
          {BLOG_FORMATS.map((f) => (
            <button
              className={`rounded-2xl border p-4 text-left transition ${
                format === f.id
                  ? 'border-emerald-500 bg-emerald-500/10'
                  : 'border-black/10 bg-white/60 hover:bg-white/90 dark:border-white/10 dark:bg-white/5'
              }`}
              key={f.id}
              onClick={() => selectFormat(f.id)}
              type="button"
            >
              <div className="font-serif text-lg">
                {f.emoji} {f.shorthand}
              </div>
              <div className="mt-1 text-neutral-500 text-sm">{f.format}</div>
            </button>
          ))}
        </div>
      </Step>

      <Step
        anchorId="step-about"
        index={3}
        total={STEPS.length}
        onNext={() => goNext('about')}
        canAdvance={composed.length > 8}
        title="Your blog, in one line."
        subtitle="A rough one-liner is fine — what is this blog about?"
      >
        <textarea
          className="w-full resize-none bg-transparent font-serif text-2xl leading-relaxed outline-none placeholder:text-neutral-400"
          id="compose-blog-about"
          name="compose-blog-about"
          onChange={(e) => setAbout(e.target.value)}
          placeholder="Weekly field notes from building production AI systems, with the failures left in."
          rows={3}
          value={about}
        />
      </Step>

      <Step
        anchorId="step-audience"
        index={4}
        total={STEPS.length}
        onNext={() => goNext('audience')}
        canAdvance
        title="Who is this for?"
        subtitle={
          selectedFormat
            ? `Audiences that ${selectedFormat.shorthand.toLowerCase()} blogs tend to win over. Pick any that apply.`
            : 'Pick a format first to see curated audiences.'
        }
      >
        {audienceOptions.length > 0 ? (
          <div className="flex flex-wrap gap-2">
            {audienceOptions.map((a) => (
              <ToggleChip
                key={a}
                label={a}
                active={audience.includes(a)}
                onClick={() => setAudience((prev) => toggle(prev, a))}
              />
            ))}
          </div>
        ) : (
          <p className="text-neutral-500 text-sm">
            Choose a format in step 2 and curated audience options will appear here.
          </p>
        )}
      </Step>

      <Step
        anchorId="step-voice"
        index={5}
        total={STEPS.length}
        onNext={() => goNext('voice')}
        canAdvance={sampleCount >= 1}
        title="Voice & tone"
        subtitle="Share at least one example blog article — links or uploads — and the AI extrapolates your voice."
      >
        <div className="space-y-4">
          <div className="flex items-center gap-2">
            <Link2 className="size-4 shrink-0 text-neutral-400" />
            <input
              autoComplete="off"
              className="flex-1 rounded-xl bg-white/60 px-3 py-2 text-sm outline-none ring-1 ring-black/5 placeholder:text-neutral-400 dark:bg-white/5 dark:ring-white/10"
              id="compose-blog-voice-link"
              name="compose-blog-voice-link"
              onChange={(e) => setLinkDraft(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter') {
                  e.preventDefault();
                  addLink();
                }
              }}
              placeholder="https://example.com/a-post-that-sounds-like-you"
              value={linkDraft}
            />
            <button
              className="rounded-full bg-neutral-950/90 px-3 py-1.5 text-neutral-200 text-sm hover:bg-neutral-800"
              onClick={addLink}
              type="button"
            >
              Add link
            </button>
          </div>

          <div className="flex items-center gap-3">
            <label
              className="flex cursor-pointer items-center gap-2 rounded-full border border-black/10 bg-white/60 px-3 py-1.5 text-neutral-700 text-sm hover:bg-white/90 dark:border-white/10 dark:bg-white/5 dark:text-neutral-300"
              htmlFor="compose-blog-voice-upload"
            >
              <FileUp className="size-3.5" />
              Upload article (.txt, .md)
              <input
                accept=".txt,.md,.markdown,text/plain,text/markdown"
                className="hidden"
                id="compose-blog-voice-upload"
                multiple
                name="compose-blog-voice-upload"
                onChange={(e) => {
                  void addFiles(e.target.files);
                  e.target.value = '';
                }}
                type="file"
              />
            </label>
            <span className="text-neutral-400 text-xs">or paste below</span>
          </div>

          <div className="flex items-start gap-2">
            <textarea
              className="flex-1 resize-none rounded-xl bg-white/60 px-3 py-2 text-sm outline-none ring-1 ring-black/5 placeholder:text-neutral-400 dark:bg-white/5 dark:ring-white/10"
              id="compose-blog-voice-paste"
              name="compose-blog-voice-paste"
              onChange={(e) => setPasteDraft(e.target.value)}
              placeholder="Paste the text of an article that sounds like you…"
              rows={3}
              value={pasteDraft}
            />
            <button
              className="rounded-full bg-neutral-950/90 px-3 py-1.5 text-neutral-200 text-sm hover:bg-neutral-800 disabled:opacity-50"
              disabled={pasteDraft.trim().length === 0}
              onClick={addPaste}
              type="button"
            >
              Add
            </button>
          </div>

          {sampleCount > 0 && (
            <div className="flex flex-wrap gap-2">
              {voiceLinks.map((link) => (
                <span
                  className="flex items-center gap-1.5 rounded-full bg-neutral-100/80 px-3 py-1.5 text-neutral-700 text-xs ring-1 ring-black/5 dark:bg-white/10 dark:text-neutral-300 dark:ring-white/10"
                  key={link}
                >
                  <Link2 className="size-3" />
                  <span className="max-w-56 truncate">{link}</span>
                  <button
                    aria-label={`Remove ${link}`}
                    onClick={() => setVoiceLinks((prev) => prev.filter((l) => l !== link))}
                    type="button"
                  >
                    <X className="size-3" />
                  </button>
                </span>
              ))}
              {voiceUploads.map((upload, i) => (
                <span
                  className="flex items-center gap-1.5 rounded-full bg-neutral-100/80 px-3 py-1.5 text-neutral-700 text-xs ring-1 ring-black/5 dark:bg-white/10 dark:text-neutral-300 dark:ring-white/10"
                  key={`${upload.name}-${i}`}
                >
                  <FileUp className="size-3" />
                  <span className="max-w-56 truncate">{upload.name}</span>
                  <button
                    aria-label={`Remove ${upload.name}`}
                    onClick={() => setVoiceUploads((prev) => prev.filter((_, j) => j !== i))}
                    type="button"
                  >
                    <X className="size-3" />
                  </button>
                </span>
              ))}
            </div>
          )}

          <div className="flex items-center gap-3">
            <button
              className="flex items-center gap-2 rounded-full bg-neutral-950/90 px-3 py-1.5 text-neutral-200 text-sm hover:bg-neutral-800 disabled:opacity-50"
              disabled={sampleCount < 1 || extrapolate.isPending}
              onClick={() => extrapolate.mutate()}
              type="button"
            >
              <Wand2 className="size-3.5" />
              {extrapolate.isPending ? 'Extrapolating…' : 'Extrapolate voice & tone'}
            </button>
            {voiceError && <span className="text-red-500 text-xs">{voiceError}</span>}
          </div>

          {profile && (
            <div className="max-h-56 overflow-y-auto whitespace-pre-wrap rounded-2xl bg-white/70 p-4 text-neutral-700 text-sm ring-1 ring-black/5 dark:bg-neutral-900/70 dark:text-neutral-300 dark:ring-white/5">
              {profile}
            </div>
          )}
        </div>
      </Step>

      <Step
        anchorId="step-rules"
        index={6}
        total={STEPS.length}
        onNext={() => goNext('rules')}
        canAdvance
        title="Absolute DOs and DO NOTs"
        subtitle="Hard rules the model must follow. One per line. Skip if you have none."
      >
        <div className="grid gap-4 sm:grid-cols-2">
          <label className="flex flex-col gap-2" htmlFor="compose-blog-dos">
            <span className="text-[11px] text-neutral-500 uppercase tracking-wide">DO</span>
            <textarea
              className="resize-none rounded-2xl bg-white/60 px-3 py-2 text-sm outline-none ring-1 ring-black/5 placeholder:text-neutral-400 dark:bg-white/5 dark:ring-white/10"
              id="compose-blog-dos"
              name="compose-blog-dos"
              onChange={(e) => setDosText(e.target.value)}
              placeholder={'Cite primary sources\nEnd every post with a question'}
              rows={6}
              value={dosText}
            />
          </label>
          <label className="flex flex-col gap-2" htmlFor="compose-blog-donts">
            <span className="text-[11px] text-neutral-500 uppercase tracking-wide">DO NOT</span>
            <textarea
              className="resize-none rounded-2xl bg-white/60 px-3 py-2 text-sm outline-none ring-1 ring-black/5 placeholder:text-neutral-400 dark:bg-white/5 dark:ring-white/10"
              id="compose-blog-donts"
              name="compose-blog-donts"
              onChange={(e) => setDontsText(e.target.value)}
              placeholder={'No em-dashes\nNo clickbait headlines'}
              rows={6}
              value={dontsText}
            />
          </label>
        </div>
      </Step>

      <Step
        anchorId="step-review"
        index={7}
        total={STEPS.length}
        onNext={() =>
          format &&
          create.mutate({
            title: title.trim(),
            format,
            description: composed,
            audience,
            voice_links: voiceLinks,
            voice_uploads: voiceUploads,
            voice_profile_md: profile || undefined,
            rules_do: parseRules(dosText),
            rules_dont: parseRules(dontsText),
          })
        }
        canAdvance={canSubmit && !create.isPending}
        title="Review & start"
        subtitle="Next you'll pick a structure and how many posts to plan at a time."
        ctaLabel={create.isPending ? 'Creating…' : 'Plan the series'}
      >
        <div className="space-y-3 rounded-2xl bg-white/70 p-5 ring-1 ring-black/5 dark:bg-neutral-900/70 dark:ring-white/5">
          <ReviewRow label="Title" value={title || '—'} />
          <ReviewRow
            label="Format"
            value={selectedFormat ? `${selectedFormat.emoji} ${selectedFormat.shorthand}` : '—'}
          />
          <ReviewRow label="About" value={composed || '—'} />
          {audience.length > 0 && <ReviewRow label="Audience" value={audience.join(' · ')} />}
          <ReviewRow
            label="Voice"
            value={
              sampleCount > 0
                ? `${sampleCount} sample${sampleCount === 1 ? '' : 's'}${
                    profile ? ' · profile extrapolated' : ' · profile on creation'
                  }`
                : '—'
            }
          />
          {parseRules(dosText).length > 0 && (
            <ReviewRow label="DO" value={parseRules(dosText).join(' · ')} />
          )}
          {parseRules(dontsText).length > 0 && (
            <ReviewRow label="DO NOT" value={parseRules(dontsText).join(' · ')} />
          )}
        </div>
        {create.isError && (
          <p className="mt-3 text-red-500 text-sm">
            {create.error instanceof Error ? create.error.message : 'Could not create the blog'}
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
