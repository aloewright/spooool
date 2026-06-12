import { useQuery } from "@tanstack/react-query";
import { createFileRoute } from "@tanstack/react-router";
import VoicePanel from "../components/panels/VoicePanel";
import { BreadcrumbPill } from "../components/studio/BreadcrumbPill";
import { SideDrawer } from "../components/studio/SideDrawer";
import { TopLeftPill } from "../components/studio/TopLeftPill";
import { api, queryKeys } from "../lib/api";
import { useDrawerLayout } from "../lib/drawer-layout";

export const Route = createFileRoute("/_hub/$projectId/voice")({ component: StudioVoice });

function StudioVoice() {
  const { projectId } = Route.useParams();
  const project = useQuery({
    queryKey: queryKeys.project(projectId),
    queryFn: () => api.getProject(projectId),
  });
  const drawer = useDrawerLayout();
  const title = project.data?.title ?? "Untitled book";

  return (
    <div className="relative min-h-screen bg-[#efece2] text-neutral-900 dark:bg-[#1a1a1a] dark:text-neutral-100">
      <SideDrawer projectId={projectId} current="voice" />
      <TopLeftPill />
      <BreadcrumbPill title={title} />

      <main
        className={`px-6 pt-28 pb-20 transition-[padding] ${
          drawer.open ? (drawer.collapsed ? "lg:pl-[5rem]" : "lg:pl-[19rem]") : ""
        }`}
      >
        <div className="mx-auto max-w-5xl">
          {project.data ? (
            <VoicePanel project={project.data} />
          ) : (
            <p className="font-serif text-neutral-500 text-sm">Loading voice library…</p>
          )}
        </div>
      </main>
    </div>
  );
}
