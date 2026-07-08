import { getBlogFormat } from "@/shared/blog-formats";
import { getScriptFormat } from "@/shared/script-formats";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Link, createFileRoute, useNavigate } from "@tanstack/react-router";
import { BookOpen, ChevronLeft, ChevronRight, Clapperboard, Plus, RotateCcw, Rss, Trash2 } from "lucide-react";
import { type ReactNode, useState } from "react";
import { type Project, api, queryKeys } from "../lib/api";

export const Route = createFileRoute("/_hub/")({ component: StudioHome });

const PAGE_SIZE = 20;

function StudioHome() {
  const nav = useNavigate();
  const qc = useQueryClient();
  const [projectPage, setProjectPage] = useState(1);
  const projects = useQuery({
    queryKey: [...queryKeys.projects(), { page: projectPage, limit: PAGE_SIZE }],
    queryFn: () => api.listProjects({ page: projectPage, limit: PAGE_SIZE }),
  });
  const deletedProjects = useQuery({
    queryKey: queryKeys.deletedProjects(),
    queryFn: api.listDeletedProjects,
  });
  const blogs = useQuery({ queryKey: queryKeys.blogs(), queryFn: api.listBlogs });
  const deletedBlogs = useQuery({
    queryKey: queryKeys.deletedBlogs(),
    queryFn: api.listDeletedBlogs,
  });
  const scripts = useQuery({ queryKey: queryKeys.scripts(), queryFn: api.listScripts });
  const deletedScripts = useQuery({
    queryKey: queryKeys.deletedScripts(),
    queryFn: api.listDeletedScripts,
  });
  const items = projects.data?.items ?? [];
  const projectTotal = projects.data?.total ?? 0;
  const projectTotalPages = Math.max(1, Math.ceil(projectTotal / PAGE_SIZE));
  const blogItems = blogs.data?.items ?? [];
  const scriptItems = scripts.data?.items ?? [];
  const deletedItems = deletedProjects.data?.items ?? [];
  const deletedBlogItems = deletedBlogs.data?.items ?? [];
  const deletedScriptItems = deletedScripts.data?.items ?? [];
  const retentionDays = deletedProjects.data?.retention_days ?? 30;

  const deleteProject = useMutation({
    mutationFn: api.deleteProject,
    onSuccess: () => {
      setProjectPage(1);
      return Promise.all([
        qc.invalidateQueries({ queryKey: queryKeys.projects() }),
        qc.invalidateQueries({ queryKey: queryKeys.deletedProjects() }),
      ]);
    },
  });

  const restoreProject = useMutation({
    mutationFn: api.restoreProject,
    onSuccess: () => {
      setProjectPage(1);
      return Promise.all([
        qc.invalidateQueries({ queryKey: queryKeys.projects() }),
        qc.invalidateQueries({ queryKey: queryKeys.deletedProjects() }),
      ]);
    },
  });

  const deleteBlog = useMutation({
    mutationFn: api.deleteBlog,
    onSuccess: () =>
      Promise.all([
        qc.invalidateQueries({ queryKey: queryKeys.blogs() }),
        qc.invalidateQueries({ queryKey: queryKeys.deletedBlogs() }),
      ]),
  });

  const restoreBlog = useMutation({
    mutationFn: api.restoreBlog,
    onSuccess: () =>
      Promise.all([
        qc.invalidateQueries({ queryKey: queryKeys.blogs() }),
        qc.invalidateQueries({ queryKey: queryKeys.deletedBlogs() }),
      ]),
  });

  const deleteScript = useMutation({
    mutationFn: api.deleteScript,
    onSuccess: () =>
      Promise.all([
        qc.invalidateQueries({ queryKey: queryKeys.scripts() }),
        qc.invalidateQueries({ queryKey: queryKeys.deletedScripts() }),
      ]),
  });

  const restoreScript = useMutation({
    mutationFn: api.restoreScript,
    onSuccess: () =>
      Promise.all([
        qc.invalidateQueries({ queryKey: queryKeys.scripts() }),
        qc.invalidateQueries({ queryKey: queryKeys.deletedScripts() }),
      ]),
  });

  function handleDelete(id: string) {
    if (typeof window === "undefined") return;
    if (!window.confirm("Delete this book? You can restore it within 30 days.")) return;
    deleteProject.mutate(id);
  }

  function handleDeleteBlog(id: string) {
    if (typeof window === "undefined") return;
    if (!window.confirm("Delete this blog? You can restore it within 30 days.")) return;
    deleteBlog.mutate(id);
  }

  function handleDeleteScript(id: string) {
    if (typeof window === "undefined") return;
    if (!window.confirm("Delete this script? You can restore it within 30 days.")) return;
    deleteScript.mutate(id);
  }

  return (
    <div className="min-h-screen bg-[#efece2] px-6 py-12 text-neutral-900 dark:bg-[#1a1a1a] dark:text-neutral-100">
      <div className="mx-auto max-w-5xl">
        <div className="mb-8 flex items-center justify-center">
          <div className="flex items-center gap-2">
            <button
              className="flex items-center gap-2 whitespace-nowrap rounded-full border border-neutral-950 bg-transparent px-4 py-2 font-medium text-neutral-950 text-sm shadow hover:bg-neutral-950 hover:text-white dark:border-white dark:text-white dark:hover:bg-white dark:hover:text-neutral-950"
              onClick={() => nav({ to: "/compose" })}
              type="button"
            >
              <Plus className="size-4" />
              New book
            </button>
            <button
              className="flex items-center gap-2 whitespace-nowrap rounded-full border border-neutral-950 bg-transparent px-4 py-2 font-medium text-neutral-950 text-sm shadow hover:bg-neutral-950 hover:text-white dark:border-white dark:text-white dark:hover:bg-white dark:hover:text-neutral-950"
              onClick={() => nav({ to: "/compose-blog" })}
              type="button"
            >
              <Rss className="size-4" />
              New blog
            </button>
            <button
              className="flex items-center gap-2 whitespace-nowrap rounded-full border border-neutral-950 bg-transparent px-4 py-2 font-medium text-neutral-950 text-sm shadow hover:bg-neutral-950 hover:text-white dark:border-white dark:text-white dark:hover:bg-white dark:hover:text-neutral-950"
              onClick={() => nav({ to: "/compose-script" })}
              type="button"
            >
              <Clapperboard className="size-4" />
              New script
            </button>
          </div>
        </div>

        <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
          {/* books */}
          {items.map((p) => (
            <div className="group relative h-44" key={p.id}>
              <Link
                className="absolute inset-0 flex flex-col justify-between rounded-2xl bg-white/80 p-5 ring-1 ring-black/5 transition hover:shadow-lg dark:bg-neutral-900/80 dark:ring-white/5"
                params={{ projectId: p.id }}
                to="/$projectId"
              >
                <div className="flex items-center gap-2 text-neutral-500 text-xs">
                  <BookOpen className="size-3.5" />
                  <span className="capitalize">{p.type}</span>
                  {p.genre?.trim() ? <span className="truncate">· {p.genre}</span> : null}
                </div>
                <div>
                  <div className="truncate font-serif text-xl tracking-tight">{p.title}</div>
                  {p.logline?.trim() ? (
                    <p className="mt-1 line-clamp-2 text-neutral-500 text-sm">{p.logline}</p>
                  ) : (
                    <div className="mt-1 text-neutral-500 text-xs">
                      {new Date(p.created_at ?? Date.now()).toLocaleDateString()}
                    </div>
                  )}
                </div>
              </Link>
              <span
                aria-hidden="true"
                className="absolute top-3 right-3 flex size-7 items-center justify-center rounded-full text-neutral-400 dark:text-neutral-500"
              >
                <BookOpen className="size-4" />
              </span>
              <button
                aria-label={`Delete ${p.title}`}
                className="absolute top-3 right-12 z-10 flex size-7 items-center justify-center rounded-full text-neutral-400 opacity-0 transition hover:bg-black/5 hover:text-neutral-900 focus:opacity-100 group-hover:opacity-100 dark:hover:bg-white/10 dark:hover:text-white"
                disabled={deleteProject.isPending && deleteProject.variables === p.id}
                onClick={(e) => {
                  e.preventDefault();
                  e.stopPropagation();
                  handleDelete(p.id);
                }}
                type="button"
              >
                <Trash2 className="size-4" />
              </button>
            </div>
          ))}
          {blogItems.map((b) => (
            <div className="group relative h-44" key={b.id}>
              <Link
                className="absolute inset-0 flex flex-col justify-between rounded-2xl bg-white/80 p-5 ring-1 ring-black/5 transition hover:shadow-lg dark:bg-neutral-900/80 dark:ring-white/5"
                params={{ blogId: b.id }}
                to="/blogs/$blogId"
              >
                <div className="flex items-center gap-2 text-neutral-500 text-xs">
                  <Rss className="size-3.5" />
                  <span>{getBlogFormat(b.format)?.shorthand ?? b.format}</span>
                </div>
                <div>
                  <div className="truncate font-serif text-xl tracking-tight">{b.title}</div>
                  {b.description.trim() ? (
                    <p className="mt-1 line-clamp-2 text-neutral-500 text-sm">{b.description}</p>
                  ) : (
                    <div className="mt-1 text-neutral-500 text-xs">
                      {new Date(b.created_at ?? Date.now()).toLocaleDateString()}
                    </div>
                  )}
                </div>
              </Link>
              <span
                aria-hidden="true"
                className="absolute top-3 right-3 flex size-7 items-center justify-center rounded-full text-neutral-400 dark:text-neutral-500"
              >
                <Rss className="size-4" />
              </span>
              <button
                aria-label={`Delete ${b.title}`}
                className="absolute top-3 right-12 z-10 flex size-7 items-center justify-center rounded-full text-neutral-400 opacity-0 transition hover:bg-black/5 hover:text-neutral-900 focus:opacity-100 group-hover:opacity-100 dark:hover:bg-white/10 dark:hover:text-white"
                disabled={deleteBlog.isPending && deleteBlog.variables === b.id}
                onClick={(e) => {
                  e.preventDefault();
                  e.stopPropagation();
                  handleDeleteBlog(b.id);
                }}
                type="button"
              >
                <Trash2 className="size-4" />
              </button>
            </div>
          ))}
          {scriptItems.map((s) => (
            <div className="group relative h-44" key={s.id}>
              <Link
                className="absolute inset-0 flex flex-col justify-between rounded-2xl bg-white/80 p-5 ring-1 ring-black/5 transition hover:shadow-lg dark:bg-neutral-900/80 dark:ring-white/5"
                params={{ scriptId: s.id }}
                to="/scripts/$scriptId"
              >
                <div className="flex items-center gap-2 text-neutral-500 text-xs">
                  <Clapperboard className="size-3.5" />
                  <span>{getScriptFormat(s.format)?.shorthand ?? s.format}</span>
                </div>
                <div>
                  <div className="truncate font-serif text-xl tracking-tight">{s.title}</div>
                  {s.logline.trim() ? (
                    <p className="mt-1 line-clamp-2 text-neutral-500 text-sm">{s.logline}</p>
                  ) : (
                    <div className="mt-1 text-neutral-500 text-xs">
                      {new Date(s.created_at ?? Date.now()).toLocaleDateString()}
                    </div>
                  )}
                </div>
              </Link>
              <span
                aria-hidden="true"
                className="absolute top-3 right-3 flex size-7 items-center justify-center rounded-full text-neutral-400 dark:text-neutral-500"
              >
                <Clapperboard className="size-4" />
              </span>
              <button
                aria-label={`Delete ${s.title}`}
                className="absolute top-3 right-12 z-10 flex size-7 items-center justify-center rounded-full text-neutral-400 opacity-0 transition hover:bg-black/5 hover:text-neutral-900 focus:opacity-100 group-hover:opacity-100 dark:hover:bg-white/10 dark:hover:text-white"
                disabled={deleteScript.isPending && deleteScript.variables === s.id}
                onClick={(e) => {
                  e.preventDefault();
                  e.stopPropagation();
                  handleDeleteScript(s.id);
                }}
                type="button"
              >
                <Trash2 className="size-4" />
              </button>
            </div>
          ))}
        </div>

        {projectTotalPages > 1 && (
          <div className="mt-6 flex items-center justify-center gap-3">
            <button
              className="flex items-center gap-1.5 rounded-full border border-neutral-300 bg-transparent px-3 py-1.5 text-sm disabled:opacity-40 dark:border-neutral-700"
              disabled={projectPage <= 1}
              onClick={() => setProjectPage((p) => p - 1)}
              type="button"
            >
              <ChevronLeft className="size-4" />
              Previous
            </button>
            <span className="text-neutral-500 text-sm">
              {projectPage} / {projectTotalPages}
            </span>
            <button
              className="flex items-center gap-1.5 rounded-full border border-neutral-300 bg-transparent px-3 py-1.5 text-sm disabled:opacity-40 dark:border-neutral-700"
              disabled={projectPage >= projectTotalPages}
              onClick={() => setProjectPage((p) => p + 1)}
              type="button"
            >
              Next
              <ChevronRight className="size-4" />
            </button>
          </div>
        )}

        {deletedItems.length + deletedBlogItems.length + deletedScriptItems.length > 0 ? (
          <details className="mt-10 rounded-2xl bg-white/60 p-5 ring-1 ring-black/5 dark:bg-neutral-900/60 dark:ring-white/5">
            <summary className="flex cursor-pointer items-center justify-between gap-3">
              <div>
                <h2 className="font-serif text-lg tracking-tight">Recently deleted</h2>
                <p className="mt-0.5 text-neutral-500 text-xs">
                  Auto-deleted after {retentionDays} days.
                </p>
              </div>
              <span className="rounded-full bg-neutral-200/60 px-2.5 py-1 text-neutral-700 text-xs dark:bg-white/10 dark:text-neutral-200">
                {deletedItems.length + deletedBlogItems.length + deletedScriptItems.length}{" "}
                recoverable
              </span>
            </summary>
            <ul className="mt-4 grid gap-2">
              {deletedItems.map((p) => (
                <DeletedRow
                  icon={<BookOpen className="size-4 text-neutral-500" />}
                  key={p.id}
                  onRestore={() => restoreProject.mutate(p.id)}
                  restoring={restoreProject.isPending && restoreProject.variables === p.id}
                  subtitle={`${daysRemaining(p.deleted_at, retentionDays)} days left to restore`}
                  title={p.title}
                />
              ))}
              {deletedBlogItems.map((b) => (
                <DeletedRow
                  icon={<Rss className="size-4 text-neutral-500" />}
                  key={b.id}
                  onRestore={() => restoreBlog.mutate(b.id)}
                  restoring={restoreBlog.isPending && restoreBlog.variables === b.id}
                  subtitle={`${daysRemaining(b.deleted_at, retentionDays)} days left to restore`}
                  title={b.title}
                />
              ))}
              {deletedScriptItems.map((s) => (
                <DeletedRow
                  icon={<Clapperboard className="size-4 text-neutral-500" />}
                  key={s.id}
                  onRestore={() => restoreScript.mutate(s.id)}
                  restoring={restoreScript.isPending && restoreScript.variables === s.id}
                  subtitle={`${daysRemaining(s.deleted_at, retentionDays)} days left to restore`}
                  title={s.title}
                />
              ))}
            </ul>
          </details>
        ) : null}
      </div>
    </div>
  );
}

function DeletedRow({
  icon,
  title,
  subtitle,
  restoring,
  onRestore,
}: {
  icon: ReactNode;
  title: string;
  subtitle: string;
  restoring: boolean;
  onRestore: () => void;
}) {
  return (
    <li className="flex items-center justify-between gap-3 rounded-xl bg-white/80 p-3 ring-1 ring-black/5 dark:bg-neutral-900/80 dark:ring-white/5">
      <div className="flex items-center gap-2">
        {icon}
        <div>
          <div className="font-medium text-sm">{title}</div>
          <div className="text-neutral-500 text-xs">{subtitle}</div>
        </div>
      </div>
      <button
        className="flex items-center gap-1.5 rounded-full bg-neutral-950 px-3 py-1.5 font-medium text-white text-xs hover:bg-neutral-800 disabled:opacity-60 dark:bg-white dark:text-neutral-950 dark:hover:bg-neutral-200"
        disabled={restoring}
        onClick={onRestore}
        type="button"
      >
        <RotateCcw className="size-3.5" />
        {restoring ? "Restoring…" : "Restore"}
      </button>
    </li>
  );
}

function daysRemaining(value: Project["deleted_at"], retentionDays: number) {
  const deletedAt = value ? new Date(value).getTime() : Date.now();
  if (Number.isNaN(deletedAt)) return retentionDays;
  const expiresAt = deletedAt + retentionDays * 24 * 60 * 60 * 1000;
  return Math.max(0, Math.ceil((expiresAt - Date.now()) / (24 * 60 * 60 * 1000)));
}
