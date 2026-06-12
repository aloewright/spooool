import { Outlet, createFileRoute, redirect } from "@tanstack/react-router";

type CanvasSearch = { logline?: string };

export const Route = createFileRoute("/_hub/$projectId")({
  validateSearch: (s: Record<string, unknown>): CanvasSearch => ({
    logline: typeof s.logline === "string" ? s.logline : undefined,
  }),
  beforeLoad: ({ params, search, location }) => {
    if (location.pathname === `/${params.projectId}`) {
      throw redirect({
        to: "/$projectId/canvas",
        params,
        search,
        replace: true,
      });
    }
  },
  component: () => <Outlet />,
});
