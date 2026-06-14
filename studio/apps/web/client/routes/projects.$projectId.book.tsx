import { createFileRoute, redirect } from "@tanstack/react-router";

export const Route = createFileRoute("/projects/$projectId/book")({
  beforeLoad: ({ params }) => {
    throw redirect({
      to: "/$projectId/book",
      params: { projectId: params.projectId },
      replace: true,
    });
  },
  component: () => null,
});
