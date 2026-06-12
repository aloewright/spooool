import { Outlet, createFileRoute } from "@tanstack/react-router";

export const Route = createFileRoute("/_hub")({ component: () => <Outlet /> });
