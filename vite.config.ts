import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

export default defineConfig({
  plugins: [react()],
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
          if (id.includes('react-router')) return 'react-router';
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
