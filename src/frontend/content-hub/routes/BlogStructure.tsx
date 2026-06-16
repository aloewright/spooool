// Blog structure picker — choose a structure + planned-post count, then plan
// the series. Ported from
// studio/apps/web/client/routes/_hub.blogs.$blogId.structure.tsx.
//
// Changes vs the studio source:
//   - File route (createFileRoute("/_hub/blogs/$blogId/structure")) → plain
//     component (BlogStructure), mounted by spooool's code-based router at
//     /studio/blogs/$blogId/structure (router.tsx).
//   - Params read via useParams({ strict: false }).
//   - Post-plan redirect navigates to the typed, registered
//     /studio/blogs/$blogId workspace.
//   - Component/lib/shared imports point at the ported copies.
import type { JSX } from 'react';
import { getBlogFormat, planPostsForStructure } from '../shared/blog-formats';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useNavigate, useParams } from '@tanstack/react-router';
import { ArrowRight, Minus, Plus, Sparkles } from 'lucide-react';
import { useEffect, useState } from 'react';
import { BlogShell } from '../components/studio/BlogShell';
import { api, queryKeys } from '../lib/api';

export function BlogStructure(): JSX.Element {
  const { blogId = '' } = useParams({ strict: false });
  const nav = useNavigate();
  const qc = useQueryClient();
  const blog = useQuery({ queryKey: queryKeys.blog(blogId), queryFn: () => api.getBlog(blogId) });

  const format = blog.data ? getBlogFormat(blog.data.format) : undefined;
  const [structure, setStructure] = useState<string | null>(null);
  const [count, setCount] = useState<number | null>(null);

  useEffect(() => {
    if (!blog.data || !format) return;
    setStructure((prev) => prev ?? blog.data.structure ?? null);
    setCount((prev) => prev ?? Math.max(blog.data.planned_posts, format.defaultPosts));
  }, [blog.data, format]);

  const plan = useMutation({
    mutationFn: (input: { structure: string; planned_posts: number }) =>
      api.planBlog(blogId, input),
    onSuccess: () =>
      Promise.all([
        qc.invalidateQueries({ queryKey: queryKeys.blog(blogId) }),
        qc.invalidateQueries({ queryKey: queryKeys.blogPosts(blogId) }),
      ]).then(() => nav({ to: '/studio/blogs/$blogId', params: { blogId } })),
  });

  if (blog.isLoading) {
    return (
      <BlogShell blogId={blogId} current="structure" maxWidth="max-w-3xl" title="Structure">
        <p className="text-neutral-500">Loading…</p>
      </BlogShell>
    );
  }
  if (!blog.data || !format) {
    return (
      <BlogShell blogId={blogId} current="structure" maxWidth="max-w-3xl" title="Structure">
        <p className="text-neutral-500">Blog not found.</p>
      </BlogShell>
    );
  }

  const posts = count ?? format.defaultPosts;
  const canSave = !!structure && posts >= format.minPosts && !plan.isPending;
  const structureDef = format.structures.find((s) => s.id === structure);
  const beatPlan = structureDef?.beats ? planPostsForStructure(structureDef, posts) : [];

  function selectStructure(id: string) {
    setStructure(id);
    // Frameworks with narrative beats default to one post per beat.
    const beats = format?.structures.find((s) => s.id === id)?.beats;
    if (beats && format) {
      setCount(Math.min(52, Math.max(format.minPosts, beats.length)));
    }
  }

  return (
    <BlogShell blogId={blogId} current="structure" maxWidth="max-w-3xl" title={blog.data.title}>
      <div>
        <div className="mb-8">
          <div className="flex items-center gap-2 text-neutral-500 text-sm">
            <Sparkles className="size-4" />
            <span>
              {format.emoji} {format.shorthand}
            </span>
          </div>
          <h1 className="mt-1 font-serif text-3xl tracking-tight">Structure the series</h1>
          <p className="mt-2 text-neutral-500">
            Pick how each {blog.data.title} post is built, then set how many posts to plan at a
            time.
          </p>
        </div>

        <h2 className="mb-3 font-serif text-xl tracking-tight">Blog structure</h2>
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
            aria-label="Fewer posts"
            className="flex size-9 items-center justify-center rounded-full border border-black/10 bg-white/60 hover:bg-white/90 disabled:opacity-40 dark:border-white/10 dark:bg-white/5"
            disabled={posts <= format.minPosts}
            onClick={() => setCount(Math.max(format.minPosts, posts - 1))}
            type="button"
          >
            <Minus className="size-4" />
          </button>
          <div className="w-28 text-center">
            <div className="font-serif text-3xl">{posts}</div>
            <div className="text-neutral-500 text-xs">post{posts === 1 ? '' : 's'} per series</div>
          </div>
          <button
            aria-label="More posts"
            className="flex size-9 items-center justify-center rounded-full border border-black/10 bg-white/60 hover:bg-white/90 disabled:opacity-40 dark:border-white/10 dark:bg-white/5"
            disabled={posts >= 52}
            onClick={() => setCount(Math.min(52, posts + 1))}
            type="button"
          >
            <Plus className="size-4" />
          </button>
          <span className="text-neutral-400 text-xs">
            minimum {format.minPosts} for {format.shorthand.toLowerCase()}
          </span>
        </div>

        {beatPlan.length > 0 && (
          <div className="mt-8">
            <h2 className="mb-1 font-serif text-xl tracking-tight">Series plan</h2>
            <p className="mb-3 text-neutral-500 text-sm">
              {structureDef?.label} mapped onto {posts} posts — each slot becomes a planned post you
              can rename and draft.
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
            onClick={() => structure && plan.mutate({ structure, planned_posts: posts })}
            type="button"
          >
            {plan.isPending ? 'Planning…' : 'Plan posts'}
            <ArrowRight className="size-3.5" />
          </button>
          {plan.isError && (
            <span className="text-red-500 text-sm">
              {plan.error instanceof Error ? plan.error.message : 'Could not save the plan'}
            </span>
          )}
        </div>
      </div>
    </BlogShell>
  );
}
