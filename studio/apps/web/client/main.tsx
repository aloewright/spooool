import { QueryClientProvider } from "@tanstack/react-query";
import { RouterProvider, createRouter } from "@tanstack/react-router";
import { useEffect, useState } from "react";
import { createRoot } from "react-dom/client";
import { queryClient } from "./lib/api";
import { appBase } from "./lib/app-base";
import { applyThemePreference, watchSystemTheme } from "./lib/theme";
import { routeTree } from "./routeTree.gen";
import "./index.css";

const CHUNK_ERROR_EVENT = "book-cook:chunk-load-failed";

applyThemePreference();
watchSystemTheme();

function isDynamicImportError(reason: unknown) {
  const message =
    reason instanceof Error ? reason.message : typeof reason === "string" ? reason : String(reason);
  return /Failed to fetch dynamically imported module|Importing a module script failed|error loading dynamically imported module/i.test(
    message,
  );
}

window.addEventListener("unhandledrejection", (event) => {
  if (!isDynamicImportError(event.reason)) return;
  event.preventDefault();
  window.dispatchEvent(new CustomEvent(CHUNK_ERROR_EVENT));
});

// basepath keeps router matching and Link/navigate hrefs correct when the
// app is served under spooool.com/studio (see src/shared/app-base.ts).
const router = createRouter({ routeTree, basepath: appBase || undefined });
declare module "@tanstack/react-router" {
  interface Register {
    router: typeof router;
  }
}

function ChunkLoadNotice() {
  const [visible, setVisible] = useState(false);

  useEffect(() => {
    const showNotice = () => setVisible(true);
    window.addEventListener(CHUNK_ERROR_EVENT, showNotice);
    return () => window.removeEventListener(CHUNK_ERROR_EVENT, showNotice);
  }, []);

  if (!visible) return null;

  return (
    <div className="fixed right-4 bottom-4 z-50 max-w-sm rounded-md border border-border bg-background p-4 text-sm text-foreground shadow-lg">
      <p className="font-semibold">Update ready</p>
      <p className="mt-1 text-muted-foreground">
        A refreshed app bundle is available. Reload when you are ready.
      </p>
      <div className="mt-3 flex justify-end gap-2">
        <button
          type="button"
          className="rounded-md px-3 py-2 text-muted-foreground transition-colors hover:bg-accent hover:text-foreground"
          onClick={() => setVisible(false)}
        >
          Dismiss
        </button>
        <button
          type="button"
          className="rounded-md bg-primary px-3 py-2 text-primary-foreground transition-opacity hover:opacity-90"
          onClick={() => window.location.reload()}
        >
          Reload
        </button>
      </div>
    </div>
  );
}

const root = document.getElementById("root");
if (!root) throw new Error("missing #root");
createRoot(root).render(
  <QueryClientProvider client={queryClient}>
    <RouterProvider router={router} />
    <ChunkLoadNotice />
  </QueryClientProvider>,
);
