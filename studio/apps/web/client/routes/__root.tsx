import { Outlet, createRootRoute, useLocation } from "@tanstack/react-router";
import { AssistantPanel } from "../components/studio/AssistantPanel";

export const Route = createRootRoute({
  component: RootLayout,
});

// Hub routes are flattened to the root, so a project workspace lives at
// /{projectId}/... — any first path segment that isn't one of these static
// top-level routes is a project id.
const NON_PROJECT_SEGMENTS = new Set([
  "welcome",
  "sign-in",
  "sign-up",
  "dashboard",
  "account",
  "admin",
  "scout",
  "projects",
  "compose",
  "compose-blog",
  "compose-script",
  "blogs",
  "scripts",
  "new",
]);

function RootLayout() {
  const location = useLocation();
  // Extract the project id from any /{id}/... pathname. The chat panel
  // mounts at the ROOT so it survives any nested route transition
  // (including the bare /{id} → /{id}/canvas beforeLoad redirect, which
  // previously caused the _hub.$projectId shell to remount and the
  // WebSocket to reconnect twice on arrival).
  const studioMatch = location.pathname.match(/^\/([^/]+)(?:\/|$)/);
  const studioProjectId =
    studioMatch && !NON_PROJECT_SEGMENTS.has(studioMatch[1]) ? studioMatch[1] : null;

  return (
    <div className="fixed inset-0 overflow-y-auto bg-[#efece2] text-neutral-900 dark:bg-[#1a1a1a] dark:text-neutral-100">
      <Outlet />
      {studioProjectId && <AssistantPanel key={studioProjectId} projectId={studioProjectId} />}
    </div>
  );
}
