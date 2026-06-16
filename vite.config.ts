import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import tailwindcss from '@tailwindcss/vite';

export default defineConfig({
  // Tailwind v4 powers ONLY the ported content hub (src/frontend/content-hub).
  // Its single CSS entry (content-hub/styles/content-hub.css) imports just the
  // theme + utilities layers (NO Preflight), so the global design system
  // (strand.css) is untouched. The plugin auto-detects class usage from the
  // sources Tailwind scans; spooool's other pages emit no Tailwind utilities.
  plugins: [react(), tailwindcss()],
  build: {
    outDir: 'dist',
    emptyOutDir: true,
    // Threshold is informational; with manualChunks below the largest async
    // chunk is the watch-page bundle including video.js + VHS.
    chunkSizeWarningLimit: 700,
    rollupOptions: {
      output: {
        manualChunks(id: string): string | undefined {
          if (!id.includes('node_modules')) return undefined;
          // ALO-204: video.js + VHS are only loaded when the watch page
          // mounts (lazy route), so keep them out of the eager vendor chunk.
          if (id.includes('video.js') || id.includes('@videojs')) return 'videojs';
          // ALO-166: PostHog is dynamic-imported from main.tsx after first
          // paint; isolate so the eager vendor chunk stays small.
          if (id.includes('posthog-js')) return 'posthog';
          // The frontend router is @tanstack/react-router (phase 3b migration
          // off react-router-dom). Isolate it from the eager vendor chunk.
          if (id.includes('@tanstack/react-router') || id.includes('@tanstack/router') || id.includes('@tanstack/history')) {
            return 'tanstack-router';
          }
          if (id.includes('react-dom')) return 'react-dom';
          if (id.includes('/react/')) return 'react';
          if (id.includes('better-auth')) return 'better-auth';
          if (id.includes('@hotwired/turbo')) return 'turbo';
          // web-vitals is only reached via the lazy import('./lib/rum'),
          // so isolating it keeps the eager `vendor` chunk smaller.
          if (id.includes('web-vitals')) return 'web-vitals';
          // @tanstack/ai* (ai-react + ai-client) is only loaded by the lazy /studio
          // route — keep it out of the eager vendor chunk.
          if (id.includes('@tanstack/ai')) return 'tanstack-ai';
          // The content hub (lazy /studio route) is the only consumer of
          // react-query and the markdown renderer — isolate them so they never
          // inflate the eager vendor chunk.
          if (id.includes('@tanstack/react-query') || id.includes('@tanstack/query-core')) {
            return 'react-query';
          }
          if (
            id.includes('react-markdown') ||
            id.includes('remark-') ||
            id.includes('micromark') ||
            id.includes('mdast') ||
            id.includes('hast') ||
            id.includes('unist') ||
            id.includes('unified')
          ) {
            return 'markdown';
          }
          // Remotion + sub-packages are only used by the lazy /record route;
          // keep them out of vendor so they never inflate the eager bundle.
          if (id.includes('remotion') || id.includes('@remotion')) return 'remotion';
          // Sentry has its own caching story and grows independently of React;
          // isolate it so vendor cache isn't busted on Sentry upgrades.
          if (id.includes('@sentry/')) return 'sentry';
          // Group long-tail node_modules together so we don't end up with
          // dozens of tiny chunks (cf. https://rolldown.rs/reference/OutputOptions).
          return 'vendor';
        },
      },
    },
  },
  server: {
    port: 5173,
    // Proxy API requests to wrangler dev during local development
    proxy: {
      '/api': {
        target: 'http://localhost:8787',
        changeOrigin: true,
      },
    },
  },
});
