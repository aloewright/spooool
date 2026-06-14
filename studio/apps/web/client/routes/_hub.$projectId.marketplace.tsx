import { useQuery } from "@tanstack/react-query";
import { createFileRoute, useNavigate } from "@tanstack/react-router";
import ConceptScoutPanel from "../components/panels/ConceptScoutPanel";
import LaunchPanel from "../components/panels/LaunchPanel";
import PublishPanel from "../components/panels/PublishPanel";
import { BreadcrumbPill } from "../components/studio/BreadcrumbPill";
import { SideDrawer } from "../components/studio/SideDrawer";
import { TopLeftPill } from "../components/studio/TopLeftPill";
import { api, queryKeys } from "../lib/api";
import { useDrawerLayout } from "../lib/drawer-layout";

type MarketplaceTab = "scout" | "launch" | "publish";

type MarketplaceSearch = { tab?: MarketplaceTab };

const TABS: { id: MarketplaceTab; label: string }[] = [
  { id: "scout", label: "Scout" },
  { id: "launch", label: "Launch" },
  { id: "publish", label: "Publish" },
];

function isTab(v: unknown): v is MarketplaceTab {
  return v === "scout" || v === "launch" || v === "publish";
}

export const Route = createFileRoute("/_hub/$projectId/marketplace")({
  component: StudioMarketplace,
  validateSearch: (s: Record<string, unknown>): MarketplaceSearch => ({
    tab: isTab(s.tab) ? s.tab : undefined,
  }),
});

function StudioMarketplace() {
  const { projectId } = Route.useParams();
  const { tab } = Route.useSearch();
  const nav = useNavigate({ from: Route.fullPath });
  const active: MarketplaceTab = tab ?? "scout";

  const project = useQuery({
    queryKey: queryKeys.project(projectId),
    queryFn: () => api.getProject(projectId),
  });
  const drawer = useDrawerLayout();
  const title = project.data?.title ?? "Untitled book";
  const tabLabel = TABS.find((t) => t.id === active)?.label ?? "Scout";

  return (
    <div className="relative min-h-screen bg-[#efece2] text-neutral-900 dark:bg-[#1a1a1a] dark:text-neutral-100">
      <SideDrawer projectId={projectId} current="marketplace" />
      <TopLeftPill />
      <BreadcrumbPill title={title} />

      <main
        className={`px-6 pt-28 pb-20 transition-[padding] ${
          drawer.open ? (drawer.collapsed ? "lg:pl-[5rem]" : "lg:pl-[19rem]") : ""
        }`}
      >
        <div className="mx-auto max-w-6xl">
          <div className="mb-6 inline-flex items-center gap-1 rounded-full bg-neutral-950/90 p-1 text-neutral-200 text-sm shadow-lg ring-1 ring-white/5 backdrop-blur">
            {TABS.map((t) => (
              <button
                key={t.id}
                className={`rounded-full px-4 py-1.5 transition ${
                  active === t.id ? "bg-white/15 text-white" : "hover:bg-white/10"
                }`}
                onClick={() => nav({ search: { tab: t.id } })}
                type="button"
              >
                {t.label}
              </button>
            ))}
          </div>

          {project.data ? (
            active === "scout" ? (
              <ConceptScoutPanel project={project.data} />
            ) : active === "launch" ? (
              <LaunchPanel projectId={projectId} />
            ) : (
              <PublishPanel project={project.data} />
            )
          ) : (
            <p className="font-serif text-neutral-500 text-sm">Loading…</p>
          )}
        </div>
      </main>
    </div>
  );
}
