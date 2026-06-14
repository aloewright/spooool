import { createFileRoute, redirect } from "@tanstack/react-router";

export const Route = createFileRoute("/projects/$projectId/chapters/$chapterId")({
  beforeLoad: ({ params }) => {
    throw redirect({
      to: "/$projectId/chapters/$chapterId",
      params: { projectId: params.projectId, chapterId: params.chapterId },
      replace: true,
    });
  },
  component: () => null,
});
