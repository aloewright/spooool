import "@blocknote/core/fonts/inter.css";
import "@blocknote/mantine/style.css";
import { BlockNoteView } from "@blocknote/mantine";
import { useCreateBlockNote } from "@blocknote/react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";
import { Check, Scissors, Sparkles, Wand2, X } from "lucide-react";
import { type MouseEvent, useEffect, useMemo, useRef, useState } from "react";
import {
  type Chapter,
  type InlineEditAction,
  type InlineEditTone,
  type Section,
  api,
  queryKeys,
} from "../../lib/api";
import { useDarkMode } from "../../lib/use-theme-mode";
import { BlockNoteAiCommands } from "../editor-ai/blocknote-ai-commands";
import { Badge } from "../ui/badge";
import { Button } from "../ui/button";
import { Textarea } from "../ui/textarea";

export default function ChapterEditorPanel({
  projectId,
  chapterId,
  embedded = false,
  theme,
}: {
  projectId: string;
  chapterId: string;
  embedded?: boolean;
  theme?: "dark" | "light";
}) {
  const chapter = useQuery({
    queryKey: queryKeys.chapter(chapterId),
    queryFn: () => api.getChapter(chapterId),
  });
  const sections = useQuery({
    queryKey: queryKeys.chapterSections(chapterId),
    queryFn: () => api.getChapterSections(chapterId),
  });

  if (chapter.isLoading || !chapter.data) {
    return <p className="px-6 py-12 text-muted-foreground">Loading chapter...</p>;
  }

  const chapterEditor = (
    <ChapterEditor
      chapter={chapter.data}
      sections={sections.data?.items ?? []}
      blockNoteTheme={theme}
    />
  );

  if (embedded) {
    return (
      <div className={`mx-auto w-full max-w-4xl px-2 py-2 ${theme === "dark" ? "dark" : ""}`}>
        {chapterEditor}
      </div>
    );
  }

  return (
    <main className="min-w-0 overflow-y-auto px-6 py-6">
      <div className="mx-auto max-w-4xl">
        <div className="mb-5 flex flex-wrap items-center justify-between gap-3 border-b pb-4">
          <div className="min-w-0 flex-1">
            <Link
              to="/$projectId"
              params={{ projectId }}
              className="text-sm text-muted-foreground hover:text-foreground"
            >
              Back to workspace
            </Link>
            <h1 className="mt-2 text-2xl font-semibold">
              {chapter.data.ordinal}. {chapter.data.title}
            </h1>
            <p className="mt-2 max-w-3xl whitespace-pre-wrap text-sm leading-6 text-muted-foreground">
              {chapter.data.summary}
            </p>
          </div>
          <div className="flex flex-wrap items-center gap-2">
            <Button asChild variant="outline">
              <Link to="/$projectId/book" params={{ projectId }}>
                View full book
              </Link>
            </Button>
            <ChapterStats chapter={chapter.data} />
          </div>
        </div>
        {chapterEditor}
      </div>
    </main>
  );
}

function ChapterStats({ chapter }: { chapter: Chapter }) {
  const words = wordCount(chapter.draft_md);
  return (
    <div className="flex flex-wrap items-center gap-2">
      <Badge variant="secondary">{chapter.status}</Badge>
      <Badge>
        {words.toLocaleString()} / {chapter.target_words.toLocaleString()} words
      </Badge>
    </div>
  );
}

function ChapterEditor({
  chapter,
  sections,
  blockNoteTheme,
}: {
  chapter: Chapter;
  sections: Section[];
  blockNoteTheme?: "dark" | "light";
}) {
  return (
    <ChapterEditorInner
      key={chapter.id}
      chapter={chapter}
      sections={sections}
      blockNoteTheme={blockNoteTheme}
    />
  );
}

function ChapterEditorInner({
  chapter,
  sections,
  blockNoteTheme,
}: {
  chapter: Chapter;
  sections: Section[];
  blockNoteTheme?: "dark" | "light";
}) {
  const queryClient = useQueryClient();
  const [saveState, setSaveState] = useState<"idle" | "saving" | "saved" | "error">("idle");
  const [lastSavedWords, setLastSavedWords] = useState(wordCount(chapter.draft_md));
  const [review, setReview] = useState<{ sectionId: string; before: string; after: string } | null>(
    null,
  );
  const [selectedText, setSelectedText] = useState("");
  const [inlineReview, setInlineReview] = useState<{
    before: string;
    after: string;
    action: InlineEditAction;
  } | null>(null);
  const [redraftInstructions, setRedraftInstructions] = useState<Record<string, string>>({});
  const pendingSave = useRef<number | undefined>(undefined);
  // Tracks the in-flight autosave so a newer save can abort an older one
  // before it lands — without this an earlier (slow) request could resolve
  // last and clobber the editor's latest content on the server.
  const inFlightSave = useRef<AbortController | null>(null);
  const editorRoot = useRef<HTMLDivElement | null>(null);
  const editor = useCreateBlockNote({
    initialContent: initialContent(chapter),
  });

  const saveMutation = useMutation({
    mutationFn: async () => {
      // Supersede any save still in flight so out-of-order responses can't
      // overwrite newer content.
      inFlightSave.current?.abort();
      const controller = new AbortController();
      inFlightSave.current = controller;
      const draftJson = editor.document;
      const draftMd = await editor.blocksToMarkdownLossy(editor.document);
      const words = wordCount(draftMd);
      await api.updateChapter(
        chapter.id,
        {
          draft_json: draftJson,
          draft_md: draftMd,
          status: words > 0 ? "drafting" : "pending",
        },
        { signal: controller.signal },
      );
      return words;
    },
    onMutate: () => setSaveState("saving"),
    onSuccess: async (words) => {
      setLastSavedWords(words);
      setSaveState("saved");
      await queryClient.invalidateQueries({ queryKey: queryKeys.chapter(chapter.id) });
    },
    onError: (error) => {
      // A save we deliberately aborted (superseded by a newer one) isn't a
      // real failure — don't flip the UI to "error" for it.
      if (error instanceof DOMException && error.name === "AbortError") return;
      setSaveState("error");
    },
  });

  const draftMutation = useMutation({
    mutationFn: (input: { sectionId: string; instruction?: string }) =>
      api.draftSection(chapter.id, input.sectionId, { instruction: input.instruction }),
    onSuccess: async (data) => {
      setReview({
        sectionId: data.section.id,
        before: data.revision.before_md,
        after: data.revision.after_md,
      });
      await queryClient.invalidateQueries({ queryKey: queryKeys.chapterSections(chapter.id) });
      await queryClient.invalidateQueries({ queryKey: queryKeys.chapterRevisions(chapter.id) });
    },
  });

  const updateSectionMutation = useMutation({
    mutationFn: ({ sectionId, input }: { sectionId: string; input: Partial<Section> }) =>
      api.updateSection(chapter.id, sectionId, {
        status: input.status,
        draft_md: input.draft_md,
      }),
    onSuccess: async () => {
      await queryClient.invalidateQueries({ queryKey: queryKeys.chapterSections(chapter.id) });
    },
  });

  const inlineEditMutation = useMutation({
    mutationFn: async (input: {
      action: InlineEditAction;
      tone?: InlineEditTone;
      text: string;
    }) => {
      const contextMd = await editor.blocksToMarkdownLossy(editor.document);
      return api.reviseChapterSelection(chapter.id, {
        action: input.action,
        tone: input.tone,
        text: input.text,
        context_md: contextMd,
      });
    },
    onSuccess: async (data, variables) => {
      setInlineReview({
        before: data.revision.before_md,
        after: data.revision.after_md,
        action: variables.action,
      });
      await queryClient.invalidateQueries({ queryKey: queryKeys.chapterRevisions(chapter.id) });
    },
  });
  const darkMode = useDarkMode();
  const resolvedBlockNoteTheme = blockNoteTheme ?? (darkMode ? "dark" : "light");

  useEffect(() => {
    return () => {
      if (pendingSave.current) window.clearTimeout(pendingSave.current);
      // Cancel any save still in flight so it can't resolve and set state on
      // an unmounted component.
      inFlightSave.current?.abort();
    };
  }, []);

  useEffect(() => {
    return editor.onSelectionChange(() => {
      setSelectedText(getSelectedText(editorRoot.current));
    });
  }, [editor]);

  useEffect(() => {
    const syncSelection = () => setSelectedText(getSelectedText(editorRoot.current));
    document.addEventListener("selectionchange", syncSelection);
    document.addEventListener("keyup", syncSelection);
    document.addEventListener("mouseup", syncSelection);
    return () => {
      document.removeEventListener("selectionchange", syncSelection);
      document.removeEventListener("keyup", syncSelection);
      document.removeEventListener("mouseup", syncSelection);
    };
  }, []);

  const statusText = useMemo(() => {
    if (saveState === "saving") return "Saving...";
    if (saveState === "saved") return "Saved";
    if (saveState === "error") return "Save failed";
    return "Ready";
  }, [saveState]);

  async function saveNow() {
    if (pendingSave.current) {
      window.clearTimeout(pendingSave.current);
      pendingSave.current = undefined;
    }
    return saveMutation.mutateAsync();
  }

  function scheduleExistingChapterSave() {
    if (pendingSave.current) window.clearTimeout(pendingSave.current);
    pendingSave.current = window.setTimeout(() => saveMutation.mutate(), 1000);
  }

  async function acceptSection(section: Section) {
    const markdown = review?.sectionId === section.id ? review.after : section.draft_md;
    if (!markdown.trim()) return;

    const blocks = await editor.tryParseMarkdownToBlocks(markdown);
    const lastBlock = editor.document.at(-1);
    if (lastBlock) {
      editor.insertBlocks(blocks, lastBlock.id, "after");
    }
    await updateSectionMutation.mutateAsync({
      sectionId: section.id,
      input: { status: "approved" },
    });
    await saveMutation.mutateAsync();
    setReview(null);
  }

  async function rejectSection(section: Section) {
    await updateSectionMutation.mutateAsync({
      sectionId: section.id,
      input: { status: "pending", draft_md: "" },
    });
    if (review?.sectionId === section.id) setReview(null);
  }

  async function runInlineEdit(action: InlineEditAction, tone?: InlineEditTone) {
    const text = getSelectedText(editorRoot.current) || selectedText;
    if (!text.trim()) return;
    setSelectedText(text);
    await inlineEditMutation.mutateAsync({ action, tone, text });
  }

  async function acceptInlineEdit() {
    if (!inlineReview?.after.trim()) return;
    editor.insertInlineContent(inlineReview.after, { updateSelection: true });
    setSelectedText(inlineReview.after);
    setInlineReview(null);
    await saveMutation.mutateAsync();
  }

  return (
    <div className="space-y-4">
      <SectionDraftPanel
        sections={sections}
        activeSectionId={draftMutation.variables?.sectionId}
        redraftInstructions={redraftInstructions}
        review={review}
        isDrafting={draftMutation.isPending}
        isUpdating={updateSectionMutation.isPending || saveMutation.isPending}
        onInstructionChange={(sectionId, value) =>
          setRedraftInstructions((current) => ({ ...current, [sectionId]: value }))
        }
        onDraft={(section) =>
          draftMutation.mutate({
            sectionId: section.id,
            instruction: redraftInstructions[section.id]?.trim(),
          })
        }
        onAccept={acceptSection}
        onReject={rejectSection}
      />

      <section className="rounded-lg border bg-background">
        <div className="flex flex-wrap items-center justify-between gap-3 border-b px-4 py-3">
          <div className="flex flex-wrap items-center gap-2 text-sm text-muted-foreground">
            <span>{statusText}</span>
            <span aria-hidden>·</span>
            <span>{lastSavedWords.toLocaleString()} saved words</span>
          </div>
          <Button type="button" variant="secondary" size="sm" onClick={() => void saveNow()}>
            Save now
          </Button>
        </div>
        <InlineAiPanel
          selectedText={selectedText}
          review={inlineReview}
          isLoading={inlineEditMutation.isPending || saveMutation.isPending}
          onRun={runInlineEdit}
          onAccept={acceptInlineEdit}
          onReject={() => setInlineReview(null)}
        />
        <div className="min-h-[560px] px-4 py-5" data-testid="chapter-editor">
          <div ref={editorRoot}>
            <BlockNoteView
              editor={editor}
              formattingToolbar={false}
              slashMenu={false}
              theme={resolvedBlockNoteTheme}
              onChange={scheduleExistingChapterSave}
            >
              <BlockNoteAiCommands
                editor={editor}
                resourceId={chapter.id}
                resourceKind="chapter"
                saveNow={saveNow}
              />
            </BlockNoteView>
          </div>
        </div>
      </section>
    </div>
  );
}

function InlineAiPanel({
  selectedText,
  review,
  isLoading,
  onRun,
  onAccept,
  onReject,
}: {
  selectedText: string;
  review: { before: string; after: string; action: InlineEditAction } | null;
  isLoading: boolean;
  onRun: (action: InlineEditAction, tone?: InlineEditTone) => void;
  onAccept: () => void;
  onReject: () => void;
}) {
  const hasSelection = selectedText.trim().length > 0;
  const preventSelectionLoss = (event: MouseEvent) => event.preventDefault();

  return (
    <div className="border-b bg-muted/20 px-4 py-3" aria-label="Inline AI edits">
      <div className="flex flex-wrap items-center gap-2">
        <span className="mr-1 text-xs font-medium uppercase text-muted-foreground">Inline AI</span>
        <Button
          type="button"
          size="sm"
          variant="secondary"
          disabled={!hasSelection || isLoading}
          onMouseDown={preventSelectionLoss}
          onClick={() => onRun("rewrite")}
        >
          <Sparkles className="h-4 w-4" />
          Rewrite
        </Button>
        <Button
          type="button"
          size="sm"
          variant="secondary"
          disabled={!hasSelection || isLoading}
          onMouseDown={preventSelectionLoss}
          onClick={() => onRun("tighten")}
        >
          <Scissors className="h-4 w-4" />
          Tighten
        </Button>
        <Button
          type="button"
          size="sm"
          variant="secondary"
          disabled={!hasSelection || isLoading}
          onMouseDown={preventSelectionLoss}
          onClick={() => onRun("expand")}
        >
          Expand
        </Button>
        <Button
          type="button"
          size="sm"
          variant="secondary"
          disabled={!hasSelection || isLoading}
          onMouseDown={preventSelectionLoss}
          onClick={() => onRun("change-tone", "punchy")}
        >
          Punchy
        </Button>
        <Button
          type="button"
          size="sm"
          variant="secondary"
          disabled={!hasSelection || isLoading}
          onMouseDown={preventSelectionLoss}
          onClick={() => onRun("fix-grammar")}
        >
          Fix grammar
        </Button>
        <span className="text-xs text-muted-foreground">
          {hasSelection
            ? `${wordCount(selectedText).toLocaleString()} selected words`
            : "Select text in the editor"}
        </span>
      </div>

      {review && (
        <div className="mt-3 rounded-md border bg-background p-3" data-testid="inline-ai-diff">
          <DiffPreview before={review.before} after={review.after} />
          <div className="mt-3 flex flex-wrap gap-2">
            <Button
              type="button"
              size="sm"
              disabled={isLoading}
              onMouseDown={preventSelectionLoss}
              onClick={onAccept}
            >
              <Check className="h-4 w-4" />
              Apply replacement
            </Button>
            <Button
              type="button"
              size="sm"
              variant="outline"
              disabled={isLoading}
              onMouseDown={preventSelectionLoss}
              onClick={onReject}
            >
              <X className="h-4 w-4" />
              Reject
            </Button>
          </div>
        </div>
      )}
    </div>
  );
}

function SectionDraftPanel({
  sections,
  activeSectionId,
  redraftInstructions,
  review,
  isDrafting,
  isUpdating,
  onInstructionChange,
  onDraft,
  onAccept,
  onReject,
}: {
  sections: Section[];
  activeSectionId?: string;
  redraftInstructions: Record<string, string>;
  review: { sectionId: string; before: string; after: string } | null;
  isDrafting: boolean;
  isUpdating: boolean;
  onInstructionChange: (sectionId: string, value: string) => void;
  onDraft: (section: Section) => void;
  onAccept: (section: Section) => void;
  onReject: (section: Section) => void;
}) {
  if (sections.length === 0) return null;

  return (
    <section className="rounded-lg border bg-background" aria-label="Section drafts">
      <div className="border-b px-4 py-3">
        <h2 className="text-sm font-semibold">Section drafts</h2>
      </div>
      <div className="divide-y">
        {sections.map((section) => {
          const activeReview = review?.sectionId === section.id ? review : null;
          const generated = activeReview?.after ?? section.draft_md;
          const busy = (isDrafting && activeSectionId === section.id) || isUpdating;
          return (
            <div key={section.id} className="space-y-3 px-4 py-4">
              <div className="flex flex-wrap items-start justify-between gap-3">
                <div className="min-w-0">
                  <div className="flex flex-wrap items-center gap-2">
                    <Badge variant="secondary">{section.ordinal}</Badge>
                    <h3 className="text-sm font-medium">{titleCase(section.kind)}</h3>
                    <Badge>{section.status}</Badge>
                  </div>
                  <p className="mt-2 text-sm text-muted-foreground">{section.prompt}</p>
                </div>
                <div className="flex min-w-[280px] flex-1 flex-wrap items-start justify-end gap-2 sm:flex-nowrap">
                  <Textarea
                    aria-label={`Redraft instructions for section ${section.ordinal}`}
                    value={redraftInstructions[section.id] ?? ""}
                    onChange={(event) => onInstructionChange(section.id, event.target.value)}
                    placeholder={
                      generated
                        ? "Redraft direction, e.g. make it tenser, preserve NovaTech, add Zeta..."
                        : "Draft direction, e.g. start after orientation, focus on Amaya's memory loss..."
                    }
                    className="min-h-10 flex-1 resize-y text-sm sm:max-w-xl"
                    disabled={busy}
                  />
                  <Button
                    type="button"
                    size="sm"
                    variant="secondary"
                    disabled={busy}
                    onClick={() => onDraft(section)}
                    className="shrink-0"
                  >
                    <Wand2 className="h-4 w-4" />
                    {busy ? "Drafting..." : generated ? "Redraft" : "Draft section"}
                  </Button>
                </div>
              </div>

              {generated && (
                <div className="rounded-md border bg-muted/30 p-3" data-testid="section-diff">
                  <DiffPreview before={activeReview?.before ?? ""} after={generated} />
                  <div className="mt-3 flex flex-wrap gap-2">
                    <Button
                      type="button"
                      size="sm"
                      disabled={busy}
                      onClick={() => onAccept(section)}
                    >
                      <Check className="h-4 w-4" />
                      Accept into chapter
                    </Button>
                    <Button
                      type="button"
                      size="sm"
                      variant="outline"
                      disabled={busy}
                      onClick={() => onReject(section)}
                    >
                      <X className="h-4 w-4" />
                      Reject
                    </Button>
                  </div>
                </div>
              )}
            </div>
          );
        })}
      </div>
    </section>
  );
}

function DiffPreview({ before, after }: { before: string; after: string }) {
  return (
    <div className="grid gap-3 md:grid-cols-2">
      <div>
        <div className="mb-1 text-xs font-medium uppercase text-muted-foreground">Before</div>
        <pre className="max-h-56 overflow-auto whitespace-pre-wrap rounded border bg-background p-3 text-xs">
          {before.trim() || "No prior draft."}
        </pre>
      </div>
      <div>
        <div className="mb-1 text-xs font-medium uppercase text-muted-foreground">Generated</div>
        <pre className="max-h-56 overflow-auto whitespace-pre-wrap rounded border bg-background p-3 text-xs">
          {after}
        </pre>
      </div>
    </div>
  );
}

function initialContent(chapter: Chapter) {
  if (Array.isArray(chapter.draft_json)) return chapter.draft_json;
  if (chapter.draft_md.trim()) {
    return [
      {
        type: "paragraph",
        content: chapter.draft_md,
      },
    ];
  }
  return [
    {
      type: "heading",
      props: { level: 2 },
      content: chapter.title,
    },
    {
      type: "paragraph",
      content: "",
    },
  ];
}

function wordCount(text: string) {
  return text.trim().match(/\b[\w'-]+\b/g)?.length ?? 0;
}

function titleCase(value: string) {
  return value
    .split(/[-_\s]+/)
    .filter(Boolean)
    .map((part) => `${part.charAt(0).toUpperCase()}${part.slice(1)}`)
    .join(" ");
}

function getSelectedText(root: HTMLElement | null) {
  const selection = window.getSelection();
  if (!selection || selection.isCollapsed || !root) return "";
  const anchor = selection.anchorNode;
  const focus = selection.focusNode;
  if (!anchor || !focus || !root.contains(anchor) || !root.contains(focus)) return "";
  return selection.toString().trim();
}
