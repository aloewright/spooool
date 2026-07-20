import { cloudflare } from "@cloudflare/vite-plugin";
import tailwindcss from "@tailwindcss/vite";
import { TanStackRouterVite } from "@tanstack/router-plugin/vite";
import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

export default defineConfig({
  plugins: [
    TanStackRouterVite({
      routesDirectory: "./client/routes",
      generatedRouteTree: "./client/routeTree.gen.ts",
    }),
    react(),
    tailwindcss(),
    cloudflare({ configPath: "./wrangler.jsonc" }),
  ],
  build: { outDir: "dist/client", emptyOutDir: true },
  experimental: {
    // The same build serves at "/" in local development and at "/studio"
    // on spooool.com, so asset URLs embedded in JS resolve at runtime
    // against globalThis.__appBase (set inline in index.html). HTML and CSS
    // keep Vite's defaults: the worker rebases HTML attribute URLs
    // (rewriteHtmlBase) and CSS asset refs are relative to the CSS file.
    renderBuiltUrl(filename, { hostType }) {
      if (hostType === "js") {
        return { runtime: `(globalThis.__appBase ?? "/") + ${JSON.stringify(filename)}` };
      }
      // CSS assets (fonts) live next to the CSS file in /assets, so relative
      // URLs resolve at any base.
      if (hostType === "css") return { relative: true };
      return undefined;
    },
  },
  resolve: {
    alias: { "@": "/src", "@client": "/client" },
  },
});
