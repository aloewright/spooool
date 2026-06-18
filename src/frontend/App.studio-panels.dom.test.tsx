// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import ReactDOM from 'react-dom/client';
import { act } from 'react-dom/test-utils';
import { RealAppAt } from './test-utils/router';
import { queryClient } from './content-hub/lib/api';

(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

// Project panels (sub-project #4, PR-4).
//
// PR-3 registered the $projectId workspace (canvas/outline). The SideDrawer
// already linked to /studio/$projectId/{book,voice,marketplace}, which 404'd.
// PR-4 registers those panel routes so the paths resolve. These tests lock in
// the route registration:
//   1. /studio/$projectId/book mounts FullBookPanel (export buttons present).
//   2. /studio/$projectId/voice mounts VoicePanel (voice library present).
//   3. /studio/$projectId/marketplace mounts ConceptScoutPanel by default and
//      switches to the Publish tab via ?tab=publish.
// All run signed-in (RequireAuth gates the /studio layout); auth is mocked via
// useSession exactly as App.studio-workspace.dom.test.tsx does.
type MockSession = { data: unknown; isPending: boolean };
let mockSession: MockSession = { data: null, isPending: false };

vi.mock('./lib/auth-client', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./lib/auth-client')>();
  return { ...actual, useSession: () => mockSession };
});

let container: HTMLDivElement | null = null;
let root: ReactDOM.Root | null = null;
let assignSpy: ReturnType<typeof vi.spyOn>;

beforeEach(() => {
  // Deterministic queries: the singleton queryClient is shared across tests, and
  // its default retry:1 uses a real-timer backoff that the fast macrotask poll
  // below can't advance — so a single transient miss would leave a panel stuck
  // on its "Loading…" state past the poll window (flaky). Disable retries and
  // clear the cache so each panel resolves on the first stubbed fetch.
  queryClient.clear();
  queryClient.setDefaultOptions({ queries: { retry: false, gcTime: 0, staleTime: 0 } });
  // /api/v1/* reads return empty/placeholder shapes so the panels render their
  // empty/loaded states without throwing.
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: RequestInfo | URL) => {
      const url = typeof input === 'string' ? input : input.toString();
      const json = (body: unknown) =>
        new Response(JSON.stringify(body), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        });
      if (url.includes('/book')) {
        return json({
          project: { id: 'p1', title: 'My Book' },
          book: {
            title: 'My Book',
            chapters: [],
            manuscript_md: '',
            total_words: 0,
            drafted_chapters: 0,
          },
          export_formats: ['pdf', 'epub'],
        });
      }
      if (url.includes('/export/jobs') || url.includes('/audiobook/jobs')) {
        return json({ items: [] });
      }
      if (url.includes('/outline')) {
        return json({ outline: null, chapters: [] });
      }
      if (url.includes('/voices')) {
        return json({ items: [] });
      }
      if (url.includes('/post-pilot') || url.includes('/postpilot')) {
        return json({ items: [] });
      }
      if (url.includes('/publisher-pack')) {
        return json({ pack: null });
      }
      if (url.includes('/narration/auditions')) {
        return json({ items: [], approved: null });
      }
      if (url.includes('/elevenlabs-key')) {
        return json({ configured: false });
      }
      if (url.includes('/scout/projects')) {
        return json({ items: [] });
      }
      if (url.includes('/launch/brief')) {
        return json({ brief: null });
      }
      if (url.includes('/session')) {
        return json({ user: { id: 'u1', email: 'w@example.com' } });
      }
      // getProject and everything else: a minimal project.
      return json({ id: 'p1', title: 'My Book', type: 'fiction', status: 'draft' });
    }),
  );
  window.sessionStorage.clear();
  window.sessionStorage.setItem('splash:seen', '1');
  assignSpy = vi.spyOn(window.location, 'assign').mockImplementation(() => {});
  mockSession = {
    data: { user: { id: 'u1', email: 'w@example.com', name: 'Writer' } },
    isPending: false,
  };
});

afterEach(() => {
  if (root) {
    act(() => {
      root!.unmount();
    });
    root = null;
  }
  if (container) {
    container.remove();
    container = null;
  }
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  window.sessionStorage.clear();
});

async function mountAt(route: string, settle?: () => boolean): Promise<void> {
  container = document.createElement('div');
  document.body.appendChild(container);
  root = ReactDOM.createRoot(container);
  await act(async () => {
    root!.render(<RealAppAt route={route} />);
  });
  const yieldMacrotask = () => new Promise<void>((r) => setTimeout(r, 0));
  // Generous poll budget: under the full suite these dom tests run alongside
  // many other files across worker threads, and CPU contention can slow the
  // lazy /studio chunk + react-query settle past a short window. 300 macrotasks
  // (returning as soon as `settle` is true) keeps the fast path fast while
  // staying robust under load.
  for (let i = 0; i < 300; i++) {
    await act(async () => {
      await yieldMacrotask();
    });
    if (settle?.()) return;
  }
}

describe('/studio/$projectId panels (PR-4)', () => {
  it('mounts the full-book panel at /studio/$projectId/book', async () => {
    await mountAt('/studio/p1/book', () => (container?.textContent ?? '').includes('Full book'));
    expect(assignSpy).not.toHaveBeenCalled();
    expect(container!.textContent ?? '').toContain('Full book');
    // With no chapters, the export-readiness empty state shows.
    expect(container!.textContent ?? '').toContain('Export PDF');
  });

  it('mounts the voice panel at /studio/$projectId/voice', async () => {
    await mountAt('/studio/p1/voice', () =>
      (container?.textContent ?? '').includes('Voice library'),
    );
    expect(assignSpy).not.toHaveBeenCalled();
    expect(container!.textContent ?? '').toContain('Voice library');
    expect(container!.textContent ?? '').toContain('Create custom voice');
  });

  it('mounts the marketplace scout tab by default and switches to publish via ?tab', async () => {
    await mountAt('/studio/p1/marketplace', () =>
      (container?.textContent ?? '').includes('Concept brief'),
    );
    expect(assignSpy).not.toHaveBeenCalled();
    // Default tab is Scout → ConceptScoutPanel.
    expect(container!.textContent ?? '').toContain('Concept brief');

    await mountAt('/studio/p1/marketplace?tab=publish', () =>
      (container?.textContent ?? '').includes('Publisher pack'),
    );
    // ?tab=publish → PublishPanel.
    expect(container!.textContent ?? '').toContain('Publisher pack');
  });
});
