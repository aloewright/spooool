import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";
import { useEffect, useState } from "react";
import {
  type NarrationApproval,
  type NarrationAudition,
  type Project,
  type PublisherPack,
  type RenderJob,
  api,
  queryKeys,
} from "../../lib/api";
import { Badge } from "../ui/badge";
import { Button } from "../ui/button";
import { Input } from "../ui/input";
import { Textarea } from "../ui/textarea";
import {
  FIELD_SLOT_IDS,
  parseVoiceIds,
  sanitizePublisherDescription,
  validateDraftPack,
} from "./_shared";

export default function PublishPanel({ project }: { project: Project }) {
  const queryClient = useQueryClient();
  const pack = useQuery({
    queryKey: queryKeys.publisherPack(project.id),
    queryFn: () => api.getPublisherPack(project.id),
  });
  const outline = useQuery({
    queryKey: queryKeys.projectOutline(project.id),
    queryFn: () => api.getProjectOutline(project.id),
  });
  const renderJobs = useQuery({
    queryKey: queryKeys.renderJobs(project.id),
    queryFn: () => api.listRenderJobs(project.id),
    refetchInterval: (query) =>
      query.state.data?.items.some((job) => job.status === "queued" || job.status === "running")
        ? 3_000
        : false,
  });
  const auditionStatus = useQuery({
    queryKey: queryKeys.narrationAuditions(project.id),
    queryFn: () => api.listNarrationAuditions(project.id),
  });
  const audiobookJobs = useQuery({
    queryKey: queryKeys.audiobookJobs(project.id),
    queryFn: () => api.listAudiobookJobs(project.id),
    refetchInterval: (query) =>
      query.state.data?.items.some((job) => job.status === "queued" || job.status === "running")
        ? 5_000
        : false,
  });
  const keyStatus = useQuery({
    queryKey: queryKeys.elevenLabsKey(),
    queryFn: api.getElevenLabsKeyStatus,
  });
  const [draft, setDraft] = useState<PublisherPack | null>(null);
  const [draftDirty, setDraftDirty] = useState(false);
  const [elevenLabsKey, setElevenLabsKey] = useState("");
  const [voiceIds, setVoiceIds] = useState("");

  useEffect(() => {
    if (!project.id) return;
    setDraft(null);
    setDraftDirty(false);
  }, [project.id]);

  useEffect(() => {
    if (!pack.data?.pack || draftDirty) return;
    setDraft(pack.data.pack);
  }, [draftDirty, pack.data?.pack]);

  const generate = useMutation({
    mutationFn: () => api.generatePublisherSeo(project.id),
    onSuccess: async ({ pack }) => {
      setDraftDirty(false);
      setDraft(pack);
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: queryKeys.publisherPack(project.id) }),
        queryClient.invalidateQueries({ queryKey: queryKeys.project(project.id) }),
      ]);
    },
  });
  const save = useMutation({
    mutationFn: (input: PublisherPack) =>
      api.updatePublisherPack(project.id, {
        title: input.title,
        subtitle: input.subtitle,
        series_name: input.series_name,
        description_html: input.description_html,
        keywords: input.keywords,
        bisac: input.bisac,
      }),
    onSuccess: async ({ pack }) => {
      setDraftDirty(false);
      setDraft(pack);
      await queryClient.invalidateQueries({ queryKey: queryKeys.publisherPack(project.id) });
    },
  });
  const approve = useMutation({
    mutationFn: () => api.approvePublisherPack(project.id),
    onSuccess: async ({ pack }) => {
      setDraftDirty(false);
      setDraft(pack);
      await queryClient.invalidateQueries({ queryKey: queryKeys.publisherPack(project.id) });
    },
  });
  const startExport = useMutation({
    mutationFn: () => api.startBookExport(project.id),
    onSuccess: async () => {
      await queryClient.invalidateQueries({ queryKey: queryKeys.renderJobs(project.id) });
    },
  });
  const saveElevenLabsKey = useMutation({
    mutationFn: () => api.saveElevenLabsKey(elevenLabsKey),
    onSuccess: async () => {
      setElevenLabsKey("");
      await queryClient.invalidateQueries({ queryKey: queryKeys.elevenLabsKey() });
    },
  });
  const startAudition = useMutation({
    mutationFn: () => api.startNarrationAudition(project.id, parseVoiceIds(voiceIds)),
    onSuccess: async () => {
      await queryClient.invalidateQueries({ queryKey: queryKeys.narrationAuditions(project.id) });
    },
  });
  const approveAudition = useMutation({
    mutationFn: (jobId: string) => api.approveNarrationAudition(project.id, jobId),
    onSuccess: async () => {
      await queryClient.invalidateQueries({ queryKey: queryKeys.narrationAuditions(project.id) });
    },
  });
  const startAudiobook = useMutation({
    mutationFn: () => api.startAudiobookMastering(project.id),
    onSuccess: async () => {
      await queryClient.invalidateQueries({ queryKey: queryKeys.audiobookJobs(project.id) });
    },
  });

  const validation = draft ? validateDraftPack(draft) : [];
  const locked = draft?.status === "approved";
  const canGenerate = (outline.data?.chapters.length ?? 0) > 0;
  const canExport = locked && (outline.data?.chapters.length ?? 0) > 0;
  const canAudition =
    locked &&
    keyStatus.data?.configured &&
    parseVoiceIds(voiceIds).length > 0 &&
    (outline.data?.chapters.length ?? 0) > 0;

  return (
    <section id="publish" className="scroll-mt-6 border-t pt-8">
      <div className="flex flex-wrap items-start justify-between gap-4">
        <div>
          <h2 className="text-xl font-semibold">Publisher pack</h2>
          <p className="mt-1 max-w-2xl text-sm text-muted-foreground">
            Generate KDP-ready metadata from the manuscript, tune each field, and approve the
            publisher pack when it is final.
          </p>
        </div>
        {draft ? (
          <Badge
            aria-label={`Publisher pack ${draft.status}`}
            variant={draft.status === "approved" ? "default" : "secondary"}
          >
            {draft.status === "approved" ? "Approved" : "Draft pack"}
          </Badge>
        ) : (
          <Badge variant="secondary">No publisher pack</Badge>
        )}
      </div>

      <div className="mt-6 grid gap-6 lg:grid-cols-[minmax(0,440px)_1fr]">
        <div className="space-y-4">
          <div className="rounded-lg border bg-background p-4">
            <div className="space-y-1">
              <h2 className="text-base font-semibold">SEO synthesis</h2>
              <p className="text-sm text-muted-foreground">
                Uses chapter titles, summaries, and available draft text.
              </p>
            </div>
            <div className="mt-4 flex flex-wrap gap-3">
              <Button
                type="button"
                disabled={!canGenerate || generate.isPending}
                onClick={() => generate.mutate()}
              >
                {generate.isPending ? "Generating..." : "Generate SEO pack"}
              </Button>
              {draft ? (
                <Button
                  type="button"
                  variant="secondary"
                  disabled={locked || save.isPending || validation.length > 0}
                  onClick={() => save.mutate(draft)}
                >
                  {save.isPending ? "Saving..." : "Save edits"}
                </Button>
              ) : null}
              {draft ? (
                <Button
                  type="button"
                  variant="outline"
                  disabled={locked || approve.isPending || validation.length > 0}
                  onClick={() => approve.mutate()}
                >
                  {approve.isPending ? "Approving..." : "Approve"}
                </Button>
              ) : null}
            </div>
            {!canGenerate ? (
              <p className="mt-3 text-sm text-muted-foreground">
                Generate an outline before creating publisher metadata.
              </p>
            ) : null}
            {[generate.error, save.error, approve.error].filter(Boolean).map((error) => (
              <p key={String(error)} className="mt-3 text-sm text-destructive">
                {(error as Error).message}
              </p>
            ))}
            {validation.length ? (
              <ul className="mt-3 space-y-1 text-sm text-destructive">
                {validation.map((item) => (
                  <li key={item}>{item}</li>
                ))}
              </ul>
            ) : null}
          </div>

          {draft ? (
            <div className="rounded-lg border bg-background p-4">
              <div className="grid gap-3">
                <label htmlFor="publisher-title" className="space-y-1 text-sm font-medium">
                  Title
                  <Input
                    id="publisher-title"
                    value={draft.title}
                    disabled={locked}
                    onChange={(event) => {
                      setDraftDirty(true);
                      setDraft({ ...draft, title: event.target.value });
                    }}
                  />
                </label>
                <label htmlFor="publisher-subtitle" className="space-y-1 text-sm font-medium">
                  Subtitle
                  <Input
                    id="publisher-subtitle"
                    value={draft.subtitle}
                    disabled={locked}
                    onChange={(event) => {
                      setDraftDirty(true);
                      setDraft({ ...draft, subtitle: event.target.value });
                    }}
                  />
                </label>
                <label htmlFor="publisher-series" className="space-y-1 text-sm font-medium">
                  Series
                  <Input
                    id="publisher-series"
                    value={draft.series_name}
                    disabled={locked}
                    placeholder="Optional"
                    onChange={(event) => {
                      setDraftDirty(true);
                      setDraft({ ...draft, series_name: event.target.value });
                    }}
                  />
                </label>
                <label htmlFor="publisher-description" className="space-y-1 text-sm font-medium">
                  Description HTML
                  <Textarea
                    id="publisher-description"
                    value={draft.description_html}
                    disabled={locked}
                    className="min-h-48 resize-y font-mono text-xs"
                    onChange={(event) => {
                      setDraftDirty(true);
                      setDraft({ ...draft, description_html: event.target.value });
                    }}
                  />
                </label>
              </div>
            </div>
          ) : null}

          <div id="launch" className="scroll-mt-6 rounded-lg border bg-background p-4">
            <div className="space-y-1">
              <h2 className="text-base font-semibold">Downloads</h2>
              <p className="text-sm text-muted-foreground">
                Export approved manuscripts to EPUB, PDF, and Kindle formats.
              </p>
            </div>
            <div className="mt-4 flex flex-wrap gap-3">
              <Button asChild variant="outline" disabled={!canGenerate}>
                <Link to="/$projectId/book" params={{ projectId: project.id }}>
                  Open full book
                </Link>
              </Button>
              <Button
                type="button"
                variant="secondary"
                disabled={!canExport || startExport.isPending}
                onClick={() => startExport.mutate()}
              >
                {startExport.isPending ? "Starting..." : "Export book"}
              </Button>
            </div>
            {!canExport ? (
              <p className="mt-3 text-sm text-muted-foreground">
                Approve the publisher pack before exporting files.
              </p>
            ) : null}
            {startExport.error ? (
              <p className="mt-3 text-sm text-destructive">{startExport.error.message}</p>
            ) : null}
            <RenderJobsList jobs={renderJobs.data?.items ?? []} />
          </div>

          <div className="rounded-lg border bg-background p-4">
            <div className="space-y-1">
              <h2 className="text-base font-semibold">Narration audition</h2>
              <p className="text-sm text-muted-foreground">
                Generate a short MP3 audition from the manuscript and approve the voice for
                audiobook mastering.
              </p>
            </div>
            <div className="mt-4 grid gap-3">
              <div className="grid gap-2 sm:grid-cols-[1fr_auto]">
                <Input
                  type="password"
                  value={elevenLabsKey}
                  onChange={(event) => setElevenLabsKey(event.target.value)}
                  placeholder={
                    keyStatus.data?.configured ? "ElevenLabs key saved" : "Paste ElevenLabs API key"
                  }
                />
                <Button
                  type="button"
                  variant="secondary"
                  disabled={!elevenLabsKey.trim() || saveElevenLabsKey.isPending}
                  onClick={() => saveElevenLabsKey.mutate()}
                >
                  {saveElevenLabsKey.isPending ? "Saving..." : "Save key"}
                </Button>
              </div>
              <Textarea
                value={voiceIds}
                onChange={(event) => setVoiceIds(event.target.value)}
                placeholder="ElevenLabs voice IDs, one per line or comma-separated"
                className="min-h-20 resize-y"
              />
              <Button
                type="button"
                variant="secondary"
                disabled={!canAudition || startAudition.isPending}
                onClick={() => startAudition.mutate()}
              >
                {startAudition.isPending ? "Rendering..." : "Audition voices"}
              </Button>
            </div>
            {!locked ? (
              <p className="mt-3 text-sm text-muted-foreground">
                Approve the publisher pack before auditioning narration.
              </p>
            ) : null}
            {[saveElevenLabsKey.error, startAudition.error, approveAudition.error]
              .filter(Boolean)
              .map((error) => (
                <p key={String(error)} className="mt-3 text-sm text-destructive">
                  {(error as Error).message}
                </p>
              ))}
            <NarrationAuditionsList
              items={auditionStatus.data?.items ?? []}
              approved={auditionStatus.data?.approved ?? null}
              approvingId={approveAudition.variables}
              onApprove={(jobId) => approveAudition.mutate(jobId)}
            />
            <div className="mt-5 border-t pt-4">
              <div className="flex flex-wrap items-center justify-between gap-3">
                <div>
                  <h3 className="text-sm font-semibold">Audiobook master</h3>
                  <p className="text-sm text-muted-foreground">
                    Render chapter narration and package ACX-ready masters.
                  </p>
                </div>
                <Button
                  type="button"
                  variant="secondary"
                  disabled={!auditionStatus.data?.approved || startAudiobook.isPending}
                  onClick={() => startAudiobook.mutate()}
                >
                  {startAudiobook.isPending ? "Starting..." : "Master audiobook"}
                </Button>
              </div>
              {startAudiobook.error ? (
                <p className="mt-3 text-sm text-destructive">{startAudiobook.error.message}</p>
              ) : null}
              <RenderJobsList
                jobs={audiobookJobs.data?.items ?? []}
                emptyMessage="No audiobook masters yet."
              />
            </div>
          </div>

          <div className="rounded-lg border bg-background p-4">
            <div className="flex flex-wrap items-center justify-between gap-3">
              <div>
                <h2 className="text-base font-semibold">Launch handoff</h2>
                <p className="text-sm text-muted-foreground">
                  Create a go-to-market brief and downloadable handoff package.
                </p>
              </div>
              <Button asChild variant="secondary" disabled={!locked}>
                <Link
                  to="/$projectId/marketplace"
                  params={{ projectId: project.id }}
                  search={{ tab: "launch" }}
                >
                  Open Launch
                </Link>
              </Button>
            </div>
            {!locked ? (
              <p className="mt-3 text-sm text-muted-foreground">
                Approve the publisher pack before generating launch assets.
              </p>
            ) : null}
          </div>
        </div>

        {draft ? (
          <div className="space-y-4">
            <div className="rounded-lg border bg-background p-4">
              <h2 className="text-base font-semibold">KDP preview</h2>
              <div className="mt-4 rounded-md border bg-muted/20 p-4">
                <h3 className="text-xl font-semibold">{draft.title}</h3>
                {draft.subtitle ? (
                  <p className="mt-1 text-muted-foreground">{draft.subtitle}</p>
                ) : null}
                {draft.series_name ? (
                  <p className="mt-1 text-sm text-muted-foreground">{draft.series_name}</p>
                ) : null}
                <div
                  className="prose prose-sm mt-4 max-w-none dark:prose-invert"
                  // biome-ignore lint/security/noDangerouslySetInnerHtml: sanitized via sanitizePublisherDescription before render.
                  dangerouslySetInnerHTML={{
                    __html: sanitizePublisherDescription(draft.description_html),
                  }}
                />
              </div>
            </div>

            <KeywordEditor
              title="Keywords"
              values={draft.keywords}
              locked={locked}
              limit={7}
              maxLength={50}
              onChange={(keywords) => {
                setDraftDirty(true);
                setDraft({ ...draft, keywords });
              }}
            />
            <KeywordEditor
              title="BISAC categories"
              values={draft.bisac}
              locked={locked}
              limit={2}
              maxLength={120}
              onChange={(bisac) => {
                setDraftDirty(true);
                setDraft({ ...draft, bisac });
              }}
            />
          </div>
        ) : (
          <div className="rounded-lg border border-dashed bg-muted/20 p-6 text-sm text-muted-foreground">
            Publisher metadata will appear here after SEO synthesis.
          </div>
        )}
      </div>
    </section>
  );
}

function RenderJobsList({
  jobs,
  emptyMessage = "No exports yet.",
}: {
  jobs: RenderJob[];
  emptyMessage?: string;
}) {
  if (!jobs.length) {
    return <p className="mt-4 text-sm text-muted-foreground">{emptyMessage}</p>;
  }
  return (
    <div className="mt-4 divide-y rounded-md border">
      {jobs.slice(0, 9).map((job) => (
        <div
          key={job.id}
          className="grid gap-2 p-3 text-sm sm:grid-cols-[80px_1fr_auto] sm:items-center"
        >
          <span className="font-medium uppercase">{job.kind}</span>
          <span className={job.status === "failed" ? "text-destructive" : "text-muted-foreground"}>
            {job.status}
            {job.error ? `: ${job.error}` : ""}
          </span>
          {job.download_url ? (
            <Button asChild size="sm" variant="outline">
              <a href={job.download_url}>Download</a>
            </Button>
          ) : null}
        </div>
      ))}
    </div>
  );
}

function NarrationAuditionsList({
  items,
  approved,
  approvingId,
  onApprove,
}: {
  items: NarrationAudition[];
  approved: NarrationApproval | null;
  approvingId?: string;
  onApprove: (jobId: string) => void;
}) {
  if (!items.length) {
    return <p className="mt-4 text-sm text-muted-foreground">No auditions yet.</p>;
  }
  return (
    <div className="mt-4 divide-y rounded-md border">
      {items.slice(0, 6).map((item) => {
        const isApproved = approved?.job_id === item.id;
        return (
          <div key={item.id} className="grid gap-3 p-3 text-sm">
            <div className="flex flex-wrap items-center justify-between gap-3">
              <div>
                <p className="font-medium">{item.voice_id || "Voice"}</p>
                <p
                  className={
                    item.status === "failed" ? "text-destructive" : "text-muted-foreground"
                  }
                >
                  {item.status}
                  {item.error ? `: ${item.error}` : ""}
                </p>
              </div>
              {isApproved ? <Badge>Approved</Badge> : null}
            </div>
            {item.audio_url ? (
              <div className="grid gap-3 sm:grid-cols-[1fr_auto] sm:items-center">
                {/* biome-ignore lint/a11y/useMediaCaption: auditions are short user-generated samples without separate transcript files yet. */}
                <audio controls src={item.audio_url} className="h-9 w-full" />
                <Button
                  type="button"
                  size="sm"
                  variant={isApproved ? "secondary" : "outline"}
                  disabled={isApproved || approvingId === item.id}
                  onClick={() => onApprove(item.id)}
                >
                  {approvingId === item.id ? "Approving..." : "Approve"}
                </Button>
              </div>
            ) : null}
          </div>
        );
      })}
    </div>
  );
}

function KeywordEditor({
  title,
  values,
  locked,
  limit,
  maxLength,
  onChange,
}: {
  title: string;
  values: string[];
  locked: boolean;
  limit: number;
  maxLength: number;
  onChange: (values: string[]) => void;
}) {
  return (
    <div className="rounded-lg border bg-background p-4">
      <div className="flex items-center justify-between">
        <h2 className="text-base font-semibold">{title}</h2>
        <span className="text-sm text-muted-foreground">
          {values.length}/{limit}
        </span>
      </div>
      <div className="mt-4 grid gap-2">
        {FIELD_SLOT_IDS.slice(0, limit).map((slot, index) => (
          <Input
            key={`${title}-${slot}`}
            value={values[index] ?? ""}
            disabled={locked}
            maxLength={maxLength}
            onChange={(event) => {
              const next = [...values];
              next[index] = event.target.value;
              onChange(next);
            }}
          />
        ))}
      </div>
    </div>
  );
}
