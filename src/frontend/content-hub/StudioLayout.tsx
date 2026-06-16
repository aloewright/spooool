// Layout for the /studio subtree (the ported content hub).
//
// Responsibilities:
//   - Mount React Query (the hub screens fetch via @tanstack/react-query).
//   - Import the studio-scoped Tailwind CSS *here* so Vite code-splits it into
//     the /studio async chunk — it never loads on home/watch/etc. The CSS
//     imports only Tailwind's theme + utilities layers (NO Preflight), so
//     spooool's global strand.css is untouched. See styles/content-hub.css.
//   - Wrap the subtree in `.studio-scope`, which carries the shadcn/tweakcn
//     design-token CSS vars (scoped, never on global :root).
//   - Render the matched child route via <Outlet/>.
import type { JSX } from 'react';
import { QueryClientProvider } from '@tanstack/react-query';
import { Outlet } from '@tanstack/react-router';
import { queryClient } from './lib/api';
import './styles/content-hub.css';

export function StudioLayout(): JSX.Element {
  return (
    <QueryClientProvider client={queryClient}>
      <div className="studio-scope">
        <Outlet />
      </div>
    </QueryClientProvider>
  );
}
