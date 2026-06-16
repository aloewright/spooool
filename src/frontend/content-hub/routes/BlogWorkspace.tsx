// Blog workspace — post list + em_dash export panel. Ported from
// studio/apps/web/client/routes/_hub.blogs.$blogId.index.tsx.
//
// Changes vs the studio source:
//   - File route (createFileRoute("/_hub/blogs/$blogId/")) → plain component
//     (BlogWorkspace), mounted by spooool's code-based router as the index child
//     of /studio/blogs/$blogId (router.tsx).
//   - Params read via useParams({ strict: false }) (the spooool convention for
//     code-based routes; see ProjectBook/ProjectCanvas).
//   - In-app navigation is /studio-absolute. The structure link is a typed
//     <Link to="/studio/blogs/$blogId/structure"> (registered in PR-5).
//   - The per-post EDIT links (/studio/blogs/$blogId/posts/$postId) target the
//     BlockNote post editor, registered in PR-6, so they are now typed <Link>s.
//   - Component/lib imports point at the ported copies under ../components,
//     ../lib, ../shared.
import type { JSX } from 'react';
import { getBlogFormat } from '../shared/blog-formats';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Link, useParams } from '@tanstack/react-router';
import { CheckCircle2, ExternalLink, PenLine, Rss, Send, Settings2, Sparkles } from 'lucide-react';
import { useState } from 'react';
import { BlogShell } from '../components/studio/BlogShell';
import { type BlogPost, api, queryKeys } from '../lib/api';

export function BlogWorkspace(): JSX.Element {
  const { blogId = '' } = useParams({ strict: false });
  const qc = useQueryClient();
  const blog = useQuery({ queryKey: queryKeys.blog(blogId), queryFn: () => api.getBlog(blogId) });
  const posts = useQuery({
    queryKey: queryKeys.blogPosts(blogId),
    queryFn: () => api.listBlogPosts(blogId),
  });
  const emdash = useQuery({
    queryKey: queryKeys.emdashToken(),
    queryFn: api.getEmdashTokenStatus,
  });

  const format = blog.data ? getBlogFormat(blog.data.format) : undefined;
  const structureLabel = format?.structures.find((s) => s.id === blog.data?.structure)?.label;

  return (
    <BlogShell blogId={blogId} current="posts" title={blog.data?.title ?? 'Untitled blog'}>
      {blog.isLoading ? (
        <p className="text-neutral-500">Loading…</p>
      ) : !blog.data || !format ? (
        <p className="text-neutral-500">Blog not found.</p>
      ) : (
        <>
          <div className="mb-8 flex items-start justify-between gap-4">
            <div>
              <div className="flex items-center gap-2 text-neutral-500 text-sm">
                <Rss className="size-4" />
                <span>
                  {format.emoji} {format.shorthand}
                  {structureLabel ? ` · ${structureLabel}` : ''}
                </span>
              </div>
              <h1 className="mt-1 font-serif text-3xl tracking-tight">{blog.data.title}</h1>
              <p className="mt-2 max-w-2xl text-neutral-500">{blog.data.description}</p>
              {(posts.data?.items ?? []).length > 0 && (
                <p className="mt-2 text-neutral-500 text-sm">
                  {seriesProgress(posts.data?.items ?? [])}
                </p>
              )}
            </div>
            <Link
              className="flex shrink-0 items-center gap-2 rounded-full border border-black/10 bg-white/60 px-4 py-2 font-medium text-neutral-700 text-sm hover:bg-white/90 dark:border-white/10 dark:bg-white/5 dark:text-neutral-300"
              params={{ blogId }}
              to="/studio/blogs/$blogId/structure"
            >
              <Settings2 className="size-4" />
              {blog.data.structure ? 'Adjust structure' : 'Plan the series'}
            </Link>
          </div>

          {(posts.data?.items ?? []).length === 0 ? (
            <div className="rounded-2xl border border-neutral-300 border-dashed bg-white/40 p-10 text-center text-neutral-500 dark:border-white/15 dark:bg-white/5">
              <Sparkles className="mx-auto mb-2 size-5" />
              <p>
                No posts planned yet.{' '}
                <Link
                  className="underline hover:text-neutral-700 dark:hover:text-neutral-300"
                  params={{ blogId }}
                  to="/studio/blogs/$blogId/structure"
                >
                  Pick a structure and planning threshold
                </Link>{' '}
                to lay out the series.
              </p>
            </div>
          ) : (
            <ul className="grid gap-2">
              {(posts.data?.items ?? []).map((p) => (
                <PostRow
                  blogId={blogId}
                  key={p.id}
                  post={p}
                  publishable={
                    (emdash.data?.configured ?? false) && Boolean(blog.data?.emdash_site)
                  }
                />
              ))}
            </ul>
          )}

          <EmdashPanel
            blogId={blogId}
            onChanged={() =>
              Promise.all([
                qc.invalidateQueries({ queryKey: queryKeys.blog(blogId) }),
                qc.invalidateQueries({ queryKey: queryKeys.emdashToken() }),
              ])
            }
            site={blog.data.emdash_site ?? ''}
            tokenConfigured={emdash.data?.configured ?? false}
          />
        </>
      )}
    </BlogShell>
  );
}

const STATUS_CHIP: Record<BlogPost['status'], string> = {
  planned: 'bg-neutral-200/70 text-neutral-600 dark:bg-white/10 dark:text-neutral-300',
  drafting: 'bg-amber-500/15 text-amber-700 dark:text-amber-400',
  drafted: 'bg-sky-500/15 text-sky-700 dark:text-sky-400',
  published: 'bg-emerald-500/15 text-emerald-700 dark:text-emerald-400',
};

function seriesProgress(items: BlogPost[]): string {
  const parts = [`${items.length} ${items.length === 1 ? 'post' : 'posts'}`];
  for (const status of ['drafting', 'drafted', 'published'] as const) {
    const n = items.filter((p) => p.status === status).length;
    if (n > 0) parts.push(`${n} ${status}`);
  }
  return parts.join(' · ');
}

function PostRow({
  blogId,
  post,
  publishable,
}: {
  blogId: string;
  post: BlogPost;
  publishable: boolean;
}) {
  const qc = useQueryClient();
  const publish = useMutation({
    mutationFn: () => api.publishBlogPost(blogId, post.id),
    onSuccess: () => qc.invalidateQueries({ queryKey: queryKeys.blogPosts(blogId) }),
  });
  const hasDraft = post.draft_md.trim().length > 0;

  // The post BlockNote editor (/studio/blogs/$blogId/posts/$postId) is
  // registered in PR-6, so the edit/open links are typed <Link>s.
  const editParams = { blogId, postId: post.id } as const;

  return (
    <li className="flex min-w-0 items-center justify-between gap-3 rounded-2xl bg-white/80 p-4 ring-1 ring-black/5 transition hover:shadow-md dark:bg-neutral-900/80 dark:ring-white/5">
      <Link
        className="group flex min-w-0 flex-1 items-center gap-3"
        to="/studio/blogs/$blogId/posts/$postId"
        params={editParams}
      >
        <div className="flex size-8 shrink-0 items-center justify-center rounded-full bg-neutral-100 font-medium text-neutral-600 text-sm dark:bg-white/10 dark:text-neutral-300">
          {post.ordinal}
        </div>
        <div className="min-w-0">
          <div className="truncate font-serif text-lg group-hover:underline">
            {post.title || `Untitled post ${post.ordinal}`}
          </div>
          <div className="mt-0.5 flex min-w-0 items-center gap-2">
            <span
              className={`shrink-0 rounded-full px-2 py-0.5 text-[11px] capitalize ${STATUS_CHIP[post.status]}`}
            >
              {post.status}
            </span>
            {post.summary.trim() ? (
              <span className="min-w-0 truncate text-neutral-500 text-xs">{post.summary}</span>
            ) : null}
          </div>
        </div>
      </Link>
      <div className="flex shrink-0 items-center gap-2">
        {post.status === 'published' ? (
          <span className="flex items-center gap-1.5 rounded-full bg-emerald-500/10 px-3 py-1.5 text-emerald-700 text-xs dark:text-emerald-400">
            <CheckCircle2 className="size-3.5" />
            Published
          </span>
        ) : hasDraft ? (
          <button
            className="flex items-center gap-1.5 rounded-full bg-neutral-950 px-3 py-1.5 font-medium text-white text-xs hover:bg-neutral-800 disabled:opacity-40 dark:bg-white dark:text-neutral-950 dark:hover:bg-neutral-200"
            disabled={!publishable || publish.isPending}
            onClick={() => publish.mutate()}
            title={
              !publishable ? 'Connect em_dash below to publish' : 'Publish to your em_dash site'
            }
            type="button"
          >
            <Send className="size-3.5" />
            {publish.isPending ? 'Publishing…' : 'Publish'}
          </button>
        ) : (
          <Link
            className="flex items-center gap-1.5 rounded-full bg-neutral-100 px-3 py-1.5 font-medium text-neutral-600 text-xs hover:bg-neutral-200 dark:bg-white/10 dark:text-neutral-300 dark:hover:bg-white/20"
            to="/studio/blogs/$blogId/posts/$postId"
            params={editParams}
          >
            <PenLine className="size-3.5" />
            Write
          </Link>
        )}
      </div>
      {publish.isError && (
        <span className="text-red-500 text-xs">
          {publish.error instanceof Error ? publish.error.message : 'Publish failed'}
        </span>
      )}
    </li>
  );
}

function EmdashPanel({
  blogId,
  site,
  tokenConfigured,
  onChanged,
}: {
  blogId: string;
  site: string;
  tokenConfigured: boolean;
  onChanged: () => Promise<unknown>;
}) {
  return (
    <EmdashPanelInner key={`${blogId}:${site}`} {...{ blogId, site, tokenConfigured, onChanged }} />
  );
}

function EmdashPanelInner({
  blogId,
  site,
  tokenConfigured,
  onChanged,
}: {
  blogId: string;
  site: string;
  tokenConfigured: boolean;
  onChanged: () => Promise<unknown>;
}) {
  const [tokenDraft, setTokenDraft] = useState('');
  const [siteDraft, setSiteDraft] = useState(site);

  const saveToken = useMutation({
    mutationFn: () => api.saveEmdashToken(tokenDraft.trim()),
    onSuccess: () => {
      setTokenDraft('');
      return onChanged();
    },
  });
  const saveSite = useMutation({
    mutationFn: () => api.updateBlog(blogId, { emdash_site: siteDraft.trim() || null }),
    onSuccess: onChanged,
  });

  return (
    <div className="mt-10 rounded-2xl bg-white/60 p-5 ring-1 ring-black/5 dark:bg-neutral-900/60 dark:ring-white/5">
      <h2 className="font-serif text-lg tracking-tight">Export · em_dash</h2>
      <p className="mt-1 text-neutral-500 text-sm">
        Publish straight to your Cloudflare domain running{' '}
        <a
          className="underline hover:text-neutral-700 dark:hover:text-neutral-300"
          href="https://github.com/emdash-cms/emdash"
          rel="noopener noreferrer"
          target="_blank"
        >
          em_dash
        </a>
        . Authenticate with{' '}
        <a
          className="underline hover:text-neutral-700 dark:hover:text-neutral-300"
          href="https://pub.fly.pm"
          rel="noopener noreferrer"
          target="_blank"
        >
          pub.fly.pm
        </a>{' '}
        once — Book Cook handles the rest.
      </p>

      {tokenConfigured ? (
        <div className="mt-4 flex items-center gap-2 text-emerald-700 text-sm dark:text-emerald-400">
          <CheckCircle2 className="size-4" />
          Authenticated with pub.fly.pm
        </div>
      ) : (
        <div className="mt-4 flex items-center gap-2">
          <input
            autoComplete="off"
            className="flex-1 rounded-xl bg-white/80 px-3 py-2 text-sm outline-none ring-1 ring-black/5 placeholder:text-neutral-400 dark:bg-white/5 dark:ring-white/10"
            id="emdash-token"
            name="emdash-token"
            onChange={(e) => setTokenDraft(e.target.value)}
            placeholder="Paste your pub.fly.pm token"
            type="password"
            value={tokenDraft}
          />
          <button
            className="rounded-full bg-neutral-950 px-4 py-2 font-medium text-sm text-white hover:bg-neutral-800 disabled:opacity-40"
            disabled={tokenDraft.trim().length < 8 || saveToken.isPending}
            onClick={() => saveToken.mutate()}
            type="button"
          >
            {saveToken.isPending ? 'Connecting…' : 'Authenticate'}
          </button>
        </div>
      )}
      {saveToken.isError && (
        <p className="mt-2 text-red-500 text-xs">
          {saveToken.error instanceof Error ? saveToken.error.message : 'Could not save the token'}
        </p>
      )}

      <div className="mt-4 flex items-center gap-2">
        <ExternalLink className="size-4 shrink-0 text-neutral-400" />
        <input
          autoComplete="off"
          className="flex-1 rounded-xl bg-white/80 px-3 py-2 text-sm outline-none ring-1 ring-black/5 placeholder:text-neutral-400 dark:bg-white/5 dark:ring-white/10"
          id="emdash-site"
          name="emdash-site"
          onChange={(e) => setSiteDraft(e.target.value)}
          placeholder="your-blog.example.com"
          value={siteDraft}
        />
        <button
          className="rounded-full bg-neutral-950 px-4 py-2 font-medium text-sm text-white hover:bg-neutral-800 disabled:opacity-40"
          disabled={saveSite.isPending || siteDraft.trim() === site}
          onClick={() => saveSite.mutate()}
          type="button"
        >
          {saveSite.isPending ? 'Saving…' : 'Save site'}
        </button>
      </div>
      {saveSite.isError && (
        <p className="mt-2 text-red-500 text-xs">
          {saveSite.error instanceof Error ? saveSite.error.message : 'Could not save the site'}
        </p>
      )}
    </div>
  );
}
