import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { createFileRoute } from "@tanstack/react-router";
import {
  Activity,
  BarChart3,
  CloudCog,
  Cpu,
  Database,
  DollarSign,
  ExternalLink,
  Search,
  Shield,
  ShieldOff,
  Sparkles,
  Users,
} from "lucide-react";
import { useState } from "react";
import { api } from "../lib/api";

export const Route = createFileRoute("/admin")({ component: AdminDashboard });

function AdminDashboard() {
  const stats = useQuery({ queryKey: ["admin", "stats"], queryFn: api.adminStats });
  const activity = useQuery({ queryKey: ["admin", "activity"], queryFn: api.adminActivity });
  const [search, setSearch] = useState("");
  const users = useQuery({
    queryKey: ["admin", "users", search],
    queryFn: () => api.adminUsers({ q: search, limit: 100 }),
  });
  const queryClient = useQueryClient();
  const toggleAdmin = useMutation({
    mutationFn: (input: { userId: string; isAdmin: boolean }) =>
      api.adminToggleAdmin(input.userId, input.isAdmin),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ["admin", "users"] }),
  });

  return (
    <div className="min-h-screen bg-background px-6 py-10 text-foreground">
      <div className="mx-auto flex max-w-7xl flex-col gap-8">
        <header className="flex items-center justify-between">
          <div>
            <div className="flex items-center gap-2 text-muted-foreground text-sm">
              <Shield className="size-4" />
              Admin
            </div>
            <h1 className="mt-1 font-serif text-3xl tracking-tight">Dashboard</h1>
          </div>
          <div className="text-muted-foreground text-xs">
            data live from D1; external links open in dashboards
          </div>
        </header>

        {/* Top-level stats */}
        <section className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
          <StatCard
            icon={<Users className="size-4" />}
            label="Users"
            value={stats.data ? stats.data.users.total : "—"}
            sub={stats.data ? `+${stats.data.users.new_7d} in last 7d` : "loading…"}
          />
          <StatCard
            icon={<Sparkles className="size-4" />}
            label="Active books"
            value={stats.data ? stats.data.projects.active : "—"}
            sub={stats.data ? `${stats.data.projects.deleted} soft-deleted` : "loading…"}
          />
          <StatCard
            icon={<BarChart3 className="size-4" />}
            label="Chapters drafted"
            value={stats.data ? stats.data.chapters.drafted : "—"}
            sub={stats.data ? `${stats.data.chapters.total} chapter rows total` : "loading…"}
          />
          <StatCard
            icon={<Activity className="size-4" />}
            label="Render jobs"
            value={stats.data ? stats.data.render_jobs.completed : "—"}
            sub={
              stats.data
                ? `${stats.data.render_jobs.running} running · ${stats.data.render_jobs.failed} failed`
                : "loading…"
            }
          />
        </section>

        {/* Money row */}
        <section className="grid gap-3 sm:grid-cols-2">
          <StatCard
            icon={<DollarSign className="size-4" />}
            label="Subscription revenue"
            value={stats.data ? formatCents(stats.data.subscription_revenue_cents) : "—"}
            sub={
              stats.data?.subscription_provider === "not_connected"
                ? "Stripe / Polar not connected"
                : (stats.data?.subscription_provider ?? "—")
            }
          />
          <StatCard
            icon={<Cpu className="size-4" />}
            label="Compute spend"
            value={stats.data ? formatCents(stats.data.compute_spend_cents) : "—"}
            sub="usage_daily + render_jobs.cost_cents"
            tone="warn"
          />
        </section>

        {/* External dashboards */}
        <section>
          <h2 className="mb-3 font-semibold text-sm uppercase tracking-wide text-muted-foreground">
            Observability
          </h2>
          <div className="grid gap-2 sm:grid-cols-2 lg:grid-cols-4">
            <ExternalTile
              label="Cloudflare Workers"
              icon={<CloudCog className="size-4" />}
              href="https://dash.cloudflare.com/?to=/:account/workers/services/view/bookgenerators-web/production"
            />
            <ExternalTile
              label="AI Gateway"
              icon={<Sparkles className="size-4" />}
              href="https://dash.cloudflare.com/?to=/:account/ai/ai-gateway"
            />
            <ExternalTile
              label="D1 console"
              icon={<Database className="size-4" />}
              href="https://dash.cloudflare.com/?to=/:account/workers/d1"
            />
            <ExternalTile
              label="Sentry"
              icon={<Activity className="size-4" />}
              href="https://sentry.io/"
            />
          </div>
        </section>

        {/* Users table */}
        <section>
          <div className="mb-3 flex items-center justify-between gap-3">
            <h2 className="font-semibold text-sm uppercase tracking-wide text-muted-foreground">
              Users {users.data ? `(${users.data.total})` : ""}
            </h2>
            <div className="relative">
              <Search className="-translate-y-1/2 pointer-events-none absolute top-1/2 left-2 size-3.5 text-muted-foreground" />
              <input
                className="rounded-md border bg-background px-7 py-1.5 text-sm outline-none focus:ring-2 focus:ring-ring"
                onChange={(e) => setSearch(e.target.value)}
                placeholder="Search by email…"
                value={search}
              />
            </div>
          </div>
          <div className="overflow-x-auto rounded-lg border">
            <table className="w-full min-w-[800px] text-sm">
              <thead className="bg-muted/30 text-left text-muted-foreground text-xs uppercase tracking-wide">
                <tr>
                  <th className="px-3 py-2">Email</th>
                  <th className="px-3 py-2">Plan</th>
                  <th className="px-3 py-2">Phase</th>
                  <th className="px-3 py-2">Books</th>
                  <th className="px-3 py-2">Budget/day</th>
                  <th className="px-3 py-2">Created</th>
                  <th className="px-3 py-2 text-right">Admin</th>
                </tr>
              </thead>
              <tbody>
                {users.data?.items.map((u) => (
                  <tr className="border-t" key={u.id}>
                    <td className="px-3 py-2">
                      <div className="font-medium">{u.email}</div>
                      {u.name && <div className="text-muted-foreground text-xs">{u.name}</div>}
                    </td>
                    <td className="px-3 py-2">
                      <span
                        className={`rounded-full px-2 py-0.5 text-xs ${
                          u.plan === "pro"
                            ? "bg-emerald-500/10 text-emerald-600 dark:text-emerald-300"
                            : "bg-muted text-muted-foreground"
                        }`}
                      >
                        {u.plan}
                      </span>
                    </td>
                    <td className="px-3 py-2 text-muted-foreground text-xs">{u.phase}</td>
                    <td className="px-3 py-2">{u.project_count}</td>
                    <td className="px-3 py-2 text-xs">{formatCents(u.daily_budget_cents)}</td>
                    <td className="px-3 py-2 text-muted-foreground text-xs">
                      {formatDate(u.createdAt)}
                    </td>
                    <td className="px-3 py-2 text-right">
                      <button
                        className="inline-flex items-center gap-1 rounded-md px-2 py-1 text-xs hover:bg-accent"
                        onClick={() => toggleAdmin.mutate({ userId: u.id, isAdmin: !u.is_admin })}
                        type="button"
                      >
                        {u.is_admin ? (
                          <>
                            <Shield className="size-3.5 text-emerald-500" /> admin
                          </>
                        ) : (
                          <>
                            <ShieldOff className="size-3.5 text-muted-foreground" /> make admin
                          </>
                        )}
                      </button>
                    </td>
                  </tr>
                ))}
                {users.data && users.data.items.length === 0 && (
                  <tr>
                    <td className="px-3 py-4 text-center text-muted-foreground" colSpan={7}>
                      No users match "{search}".
                    </td>
                  </tr>
                )}
              </tbody>
            </table>
          </div>
        </section>

        {/* Recent activity */}
        <section className="grid gap-4 lg:grid-cols-3">
          <ActivityCard
            title="Recent signups"
            items={
              activity.data?.recent_users.map((u) => ({
                primary: u.email,
                secondary: formatDate(u.createdAt),
              })) ?? []
            }
          />
          <ActivityCard
            title="Recent books"
            items={
              activity.data?.recent_projects.map((p) => ({
                primary: p.title,
                secondary: `${p.type} · ${formatDate(p.created_at)}`,
              })) ?? []
            }
          />
          <ActivityCard
            title="Recent render jobs"
            items={
              activity.data?.recent_render_jobs.map((j) => ({
                primary: `${j.kind} · ${j.status}`,
                secondary: `${formatCents(j.cost_cents)} · ${formatDate(j.started_at)}`,
              })) ?? []
            }
          />
        </section>
      </div>
    </div>
  );
}

function StatCard({
  icon,
  label,
  value,
  sub,
  tone,
}: {
  icon: React.ReactNode;
  label: string;
  value: number | string;
  sub: string;
  tone?: "warn";
}) {
  return (
    <div className="rounded-lg border bg-card p-4 text-card-foreground">
      <div className="flex items-center gap-2 text-muted-foreground text-xs uppercase tracking-wide">
        {icon}
        {label}
      </div>
      <div
        className={`mt-2 font-serif text-3xl tracking-tight ${
          tone === "warn" ? "text-amber-600 dark:text-amber-400" : ""
        }`}
      >
        {value}
      </div>
      <div className="mt-1 text-muted-foreground text-xs">{sub}</div>
    </div>
  );
}

function ExternalTile({
  icon,
  label,
  href,
}: {
  icon: React.ReactNode;
  label: string;
  href: string;
}) {
  return (
    <a
      className="group flex items-center justify-between rounded-lg border bg-card p-3 text-sm hover:bg-accent"
      href={href}
      rel="noreferrer"
      target="_blank"
    >
      <span className="flex items-center gap-2">
        {icon}
        {label}
      </span>
      <ExternalLink className="size-3.5 text-muted-foreground opacity-0 transition group-hover:opacity-100" />
    </a>
  );
}

function ActivityCard({
  title,
  items,
}: {
  title: string;
  items: { primary: string; secondary: string }[];
}) {
  return (
    <div className="rounded-lg border bg-card p-4 text-card-foreground">
      <h3 className="mb-3 font-semibold text-sm uppercase tracking-wide text-muted-foreground">
        {title}
      </h3>
      <ul className="space-y-2">
        {items.length === 0 && <li className="text-muted-foreground text-xs">No data yet.</li>}
        {items.map((item) => (
          <li className="text-sm" key={`${item.primary}-${item.secondary}`}>
            <div className="truncate">{item.primary}</div>
            <div className="text-muted-foreground text-xs">{item.secondary}</div>
          </li>
        ))}
      </ul>
    </div>
  );
}

function formatCents(cents: number): string {
  const dollars = cents / 100;
  return new Intl.NumberFormat("en-US", {
    style: "currency",
    currency: "USD",
    minimumFractionDigits: dollars < 1 ? 4 : 2,
  }).format(dollars);
}

function formatDate(unix: number | null | undefined): string {
  if (!unix) return "—";
  return new Date(unix * 1000).toLocaleDateString(undefined, {
    year: "numeric",
    month: "short",
    day: "numeric",
  });
}
