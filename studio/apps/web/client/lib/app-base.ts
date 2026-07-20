import { detectAppBase } from "@/shared/app-base";

// "" in local development, "/studio" when served via spooool.com/studio.
// Computed once at module load — the base can't change without a full navigation.
export const appBase = typeof window !== "undefined" ? detectAppBase(window.location.pathname) : "";

// Prefix for root-absolute fetch/navigation URLs that bypass the router.
export const withBase = (path: string) => `${appBase}${path}`;
