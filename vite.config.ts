import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

export default defineConfig({
  plugins: [react()],
  build: {
    outDir: 'dist',
    emptyOutDir: true,
    // Threshold is informational; with manualChunks below the largest async
    // chunk is the watch-page bundle including hls.js (~150KB raw / ~40KB gz).
    chunkSizeWarningLimit: 600,
    rollupOptions: {
      output: {
        manualChunks(id: string): string | undefined {
          if (!id.includes('node_modules')) return undefined;
          // ALO-204: hls.js is only loaded when the watch page mounts, so
          // isolate it from the eager vendor chunk.
          if (id.includes('hls.js')) return 'hls';
          if (id.includes('react-router')) return 'react-router';
          if (id.includes('react-dom')) return 'react-dom';
          if (id.includes('/react/')) return 'react';
          if (id.includes('better-auth')) return 'better-auth';
          if (id.includes('@hotwired/turbo')) return 'turbo';
          // web-vitals is only reached via the lazy import('./lib/rum'),
          // so isolating it keeps the eager `vendor` chunk smaller.
          if (id.includes('web-vitals')) return 'web-vitals';
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
