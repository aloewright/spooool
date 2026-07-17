import "@blocknote/core/fonts/inter.css";
import "@blocknote/mantine/style.css";
import { getBlogFormat } from "@/shared/blog-formats";
import { BlockNoteView } from "@blocknote/mantine";
import { useCreateBlockNote } from "@blocknote/react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { createFileRoute } from "@tanstack/react-router";
import { Rss } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { BlockNoteAiCommands } from "../components/editor-ai/blocknote-ai-commands";
import {
  DraftConflictError,
  DraftConflictNotice,
  getDraftConflictError,
} from "../components/editor-ai/draft-conflict";
import { BlogShell } from "../components/studio/BlogShell";
import { type BlogDetail, type BlogPost, api, queryKeys } from "../lib/api";
import { type SaveState, useAutosave } from "../lib/use-autosave";
import { useDarkMode } from "../lib/use-theme-mode";

export const Route = createFileRoute("/_hub/blogs/$blogId/posts/$postId")({
  component: BlogPostEditor,
});

function BlogPostEditor() {
  const { blogId, postId } = Route.useParams();
  const blog = useQuery({ queryKey: queryKeys.blog(blogId), queryFn: () => api.getBlog(blogId) });
  const post = useQuery({
    queryKey: queryKeys.blogPost(blogId, postId),
    queryFn: () => api.getBlogPost(blogId, postId),
  });

  if (blog.isLoading || post.isLoading) {
    return (
      <BlogShell blogId={blogId} current="posts" title="Post">
        <p className="text-neutral-500">Loading…</p>
      </BlogShell>
    );
  }
  if (blog.isError || post.isError) {
    const err = blog.error ?? post.error;
    return (
      <BlogShell blogId={blogId} current="posts" title="Post">
        <p className="text-neutral-500">
          Couldn't load this post{err instanceof Error ? ` — ${err.message}` : ""}.
        </p>
      </BlogShell>
    );
  }
  if (!blog.data || !post.data) {
    return (
      <BlogShell blogId={blogId} current="posts" title="Post">
        <p className="text-neutral-500">Post not found.</p>
      </BlogShell>
    );
  }

  return (
    <BlogShell blogId={blogId} current="posts" title={blog.data.title}>
      <Editor blog={blog.data} key={post.data.id} post={post.data} />
    </BlogShell>
  );
}

function Editor({ blog, post }: { blog: BlogDetail; post: BlogPost }) {
  const qc = useQueryClient();
  const format = getBlogFormat(blog.format);
  const darkMode = useDarkMode();
  const pendingSave = useRef<number | undefined>(undefined);
  const draftVersion = useRef(post.draft_version);
  const draftSequence = useRef(0);
  const [draftSessionId] = useState(() => crypto.randomUUID());
  const draftConflict = useRef(false);
  const [hasDraftConflict, setHasDraftConflict] = useState(false);
  const inFlight = useRef<AbortController | null>(null);
  const gen = useRef(0);
  const hydratedMarkdown = useRef(false);
  const [hasDraftContent, setHasDraftContent] = useState(post.draft_md.trim().length > 0);
  // True from the first keystroke until the save that captured it settles, so
  // the badge can't show "Saved" during the debounce window.
  const [isDirty, setIsDirty] = useState(false);

  const editor = useCreateBlockNote({
    initialContent:
      Array.isArray(post.draft_json) && looksLikeBlocks(post.draft_json)
        ? post.draft_json
        : undefined,
  });
  const [title, setTitle, titleState, titleAutosave] = useAutosave(post.title, (v, sig) =>
    api.updateBlogPost(blog.id, post.id, { title: v }, { signal: sig }),
  );
  const [summary, setSummary, summaryState, summaryAutosave] = useAutosave(post.summary, (v, sig) =>
    api.updateBlogPost(blog.id, post.id, { summary: v }, { signal: sig }),
  );

  function enterDraftConflict() {
    draftConflict.current = true;
    editor.isEditable = false;
    titleAutosave.cancelPendingSave();
    summaryAutosave.cancelPendingSave();
    if (pendingSave.current) {
      window.clearTimeout(pendingSave.current);
      pendingSave.current = undefined;
    }
    setHasDraftConflict(true);
  }

  // Posts drafted before the BlockNote editor only have markdown; hydrate it
  // into blocks once so nothing written in the old plain-text editor is lost.
  useEffect(() => {
    if (hydratedMarkdown.current) return;
    hydratedMarkdown.current = true;
    if (looksLikeBlocks(post.draft_json)) return;
    if (!post.draft_md.trim()) return;
    editor.replaceBlocks(editor.document, editor.tryParseMarkdownToBlocks(post.draft_md));
  }, [editor, post.draft_json, post.draft_md]);

  const saveDraft = useMutation({
    mutationFn: async () => {
      if (draftConflict.current) throw new DraftConflictError();
      // Serialize the live document and supersede any in-flight save so an
      // older request can't land after (and overwrite) a newer one.
      inFlight.current?.abort();
      const ctrl = new AbortController();
      inFlight.current = ctrl;
      const g = ++gen.current;
      const sequence = ++draftSequence.current;
      const draftJson = editor.document;
      const draftMd = editor.blocksToMarkdownLossy(editor.document);
      const expectedDraftVersion = draftVersion.current;
      try {
        const response = await api.updateBlogPost(
          blog.id,
          post.id,
          {
            draft_json: draftJson,
            draft_md: draftMd,
            draft_version: expectedDraftVersion,
            draft_session_id: draftSessionId,
            draft_sequence: sequence,
          },
          { signal: ctrl.signal },
        );
        return { draftMd, draftVersion: response.draft_version, superseded: g !== gen.current };
      } catch (err) {
        if (ctrl.signal.aborted) {
          return { draftMd, draftVersion: expectedDraftVersion, superseded: true };
        }
        const conflictError = getDraftConflictError(err);
        if (conflictError) {
          enterDraftConflict();
          throw conflictError;
        }
        throw err;
      }
    },
    onSuccess: ({ draftMd, draftVersion: savedDraftVersion, superseded }) => {
      draftVersion.current = Math.max(draftVersion.current, savedDraftVersion);
      if (superseded) return;
      setIsDirty(false);
      setHasDraftContent(draftMd.trim().length > 0);
      // The server promotes a planned post to drafting when its first draft
      // content lands; refetch so the status chip reflects that.
      if (post.status === "planned" && draftMd.trim()) {
        qc.invalidateQueries({ queryKey: queryKeys.blogPost(blog.id, post.id) });
        qc.invalidateQueries({ queryKey: queryKeys.blogPosts(blog.id) });
      }
    },
    onError: (error) => {
      if (error instanceof DraftConflictError) return;
      setIsDirty(true);
    },
  });

  async function saveNow() {
    if (draftConflict.current) throw new DraftConflictError();
    if (pendingSave.current) {
      window.clearTimeout(pendingSave.current);
      pendingSave.current = undefined;
    }
    return saveDraft.mutateAsync();
  }

  // Flush (not drop) a pending debounced save when the editor unmounts so
  // edits made just before navigating away still land.
  const flushRef = useRef<() => void>(() => {});
  flushRef.current = () => {
    if (draftConflict.current) return;
    if (pendingSave.current) {
      window.clearTimeout(pendingSave.current);
      pendingSave.current = undefined;
      saveDraft.mutate();
    }
  };
  useEffect(() => () => flushRef.current(), []);

  const setStatus = useMutation({
    mutationFn: (status: BlogPost["status"]) => api.updateBlogPost(blog.id, post.id, { status }),
    onSuccess: () =>
      Promise.all([
        qc.invalidateQueries({ queryKey: queryKeys.blogPost(blog.id, post.id) }),
        qc.invalidateQueries({ queryKey: queryKeys.blogPosts(blog.id) }),
      ]),
  });

  const draftState: SaveState = hasDraftConflict
    ? "error"
    : saveDraft.isError
      ? "error"
      : saveDraft.isPending || isDirty
        ? "saving"
        : saveDraft.isSuccess
          ? "saved"
          : "idle";
  const saveState = worstSaveState([titleState, summaryState, draftState]);
  const hasRules = blog.rules_do_json.length + blog.rules_dont_json.length > 0;

  return (
    <div>
      <div className="mb-6 flex items-center justify-between gap-3">
        <div className="flex items-center gap-2 text-neutral-500 text-xs">
          <Rss className="size-3.5" />
          <span>
            {format ? `${format.emoji} ${format.shorthand}` : blog.format} · Post {post.ordinal} ·{" "}
            <span className="capitalize">{post.status}</span>
          </span>
        </div>
        <div className="flex items-center gap-3">
          <SaveBadge
            state={saveState}
            onRetry={
              saveDraft.isError && !hasDraftConflict
                ? () => {
                    void saveNow().catch(() => undefined);
                  }
                : undefined
            }
          />
          {post.status === "published" ? (
            <span className="rounded-full bg-emerald-500/10 px-3 py-1 text-emerald-700 text-xs dark:text-emerald-400">
              Published
            </span>
          ) : (
            <button
              className="rounded-full border border-black/10 bg-white/60 px-3 py-1 text-neutral-700 text-xs hover:bg-white/90 disabled:opacity-50 dark:border-white/10 dark:bg-white/5 dark:text-neutral-300"
              disabled={
                hasDraftConflict ||
                setStatus.isPending ||
                (post.status !== "drafted" && !hasDraftContent)
              }
              onClick={() => setStatus.mutate(post.status === "drafted" ? "drafting" : "drafted")}
              type="button"
            >
              {post.status === "drafted" ? "Back to drafting" : "Mark as drafted"}
            </button>
          )}
        </div>
      </div>

      {hasDraftConflict ? (
        <div className="mb-6">
          <DraftConflictNotice onReload={() => window.location.reload()} />
        </div>
      ) : null}

      <input
        autoComplete="off"
        className="w-full bg-transparent font-serif text-3xl tracking-tight outline-none placeholder:text-neutral-400"
        id="post-title"
        name="post-title"
        disabled={hasDraftConflict}
        onChange={(e) => setTitle(e.target.value)}
        placeholder={`Untitled post ${post.ordinal}`}
        value={title}
      />

      <input
        autoComplete="off"
        className="mt-2 w-full bg-transparent text-neutral-600 text-sm outline-none placeholder:text-neutral-400 dark:text-neutral-400"
        id="post-summary"
        name="post-summary"
        disabled={hasDraftConflict}
        onChange={(e) => setSummary(e.target.value)}
        placeholder="One-line summary (used as the excerpt when publishing)"
        value={summary}
      />

      {(hasRules || blog.voice_profile_md) && (
        <details className="mt-6 rounded-2xl bg-white/60 p-4 text-sm ring-1 ring-black/5 dark:bg-neutral-900/60 dark:ring-white/5">
          <summary className="cursor-pointer text-neutral-500 text-xs uppercase tracking-wide">
            Voice & rules
          </summary>
          {blog.rules_do_json.length > 0 && (
            <p className="mt-3 text-neutral-600 dark:text-neutral-300">
              <span className="font-medium">DO:</span> {blog.rules_do_json.join(" · ")}
            </p>
          )}
          {blog.rules_dont_json.length > 0 && (
            <p className="mt-2 text-neutral-600 dark:text-neutral-300">
              <span className="font-medium">DO NOT:</span> {blog.rules_dont_json.join(" · ")}
            </p>
          )}
          {blog.voice_profile_md && (
            <pre className="mt-3 max-h-48 overflow-y-auto whitespace-pre-wrap font-sans text-neutral-500 text-xs">
              {blog.voice_profile_md}
            </pre>
          )}
        </details>
      )}

      <div className="mt-6 min-h-[60vh] rounded-2xl bg-white/70 py-5 ring-1 ring-black/5 dark:bg-neutral-900/70 dark:ring-white/5">
        <BlockNoteView
          editable={!hasDraftConflict}
          editor={editor}
          formattingToolbar={false}
          slashMenu={false}
          theme={darkMode ? "dark" : "light"}
          onChange={() => {
            setIsDirty(true);
            if (draftConflict.current) return;
            if (pendingSave.current) window.clearTimeout(pendingSave.current);
            pendingSave.current = window.setTimeout(() => {
              pendingSave.current = undefined;
              saveDraft.mutate();
            }, 1000);
          }}
        >
          <BlockNoteAiCommands
            disabled={hasDraftConflict}
            editor={editor}
            resourceId={post.id}
            resourceKind="blog-post"
            saveNow={saveNow}
          />
        </BlockNoteView>
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

function SaveBadge({ state, onRetry }: { state: SaveState; onRetry?: () => void }) {
  if (state === "idle") return null;
  const label = state === "saving" ? "Saving…" : state === "saved" ? "Saved" : "Save failed";
  const tone =
    state === "error"
      ? "text-red-500"
      : state === "saved"
        ? "text-emerald-600 dark:text-emerald-400"
        : "text-neutral-500";
  return (
    <span className={`flex items-center gap-2 text-xs ${tone}`}>
      <span>{label}</span>
      {state === "error" && onRetry ? (
        <button
          className="rounded-full border border-current/30 px-2 py-0.5 font-medium hover:bg-current/10"
          onClick={onRetry}
          type="button"
        >
          Retry save
        </button>
      ) : null}
    </span>
  );
}
