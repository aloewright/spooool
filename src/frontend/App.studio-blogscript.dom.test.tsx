// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import ReactDOM from 'react-dom/client';
import { act } from 'react-dom/test-utils';
import { RealAppAt } from './test-utils/router';
import { queryClient } from './content-hub/lib/api';

(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

// Blog + script workspaces (sub-project #4, PR-5).
//
// PR-2's blog/script create flows redirect to /studio/blogs/$blogId/structure
// and /studio/scripts/$scriptId/structure, which 404'd. PR-5 registers the blog
// + script workspace LIST + STRUCTURE views so those paths resolve. These tests
// lock in the route registration:
//   1. /studio/blogs/$blogId mounts the blog workspace (post list); the
//      structure link is the typed registered /studio/blogs/$blogId/structure.
//   2. /studio/blogs/$blogId/structure mounts the structure picker.
//   3. /studio/scripts/$scriptId mounts the script workspace (scene list).
//   4. /studio/scripts/$scriptId/structure mounts the structure picker.
// The per-post / per-scene edit links are the BlockNote editors (PR-6), not in
// the route tree yet, so they're plain <a href> — asserted below. All run
// signed-in (RequireAuth gates the /studio layout); auth is mocked via
// useSession exactly as App.studio-panels.dom.test.tsx does.
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
  // its default retry:1 uses a real-timer backoff the fast macrotask poll below
  // can't advance — disable retries and clear the cache so each query resolves
  // on the first stubbed fetch. (See App.studio-panels.dom.test.tsx.)
  queryClient.clear();
  queryClient.setDefaultOptions({ queries: { retry: false, gcTime: 0, staleTime: 0 } });
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: RequestInfo | URL) => {
      const url = typeof input === 'string' ? input : input.toString();
      const json = (body: unknown) =>
        new Response(JSON.stringify(body), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        });
      // Order matters: collection endpoints (/posts, /scenes) before the bare
      // /blogs/:id and /scripts/:id detail reads.
      if (url.includes('/emdash-token')) return json({ configured: false });
      if (url.includes('/blogs/') && url.includes('/posts')) {
        return json({
          items: [
            {
              id: 'post1',
              blog_id: 'b1',
              ordinal: 1,
              title: 'First post',
              summary: '',
              draft_md: '',
              status: 'planned',
              created_at: 0,
              updated_at: 0,
            },
          ],
        });
      }
      if (url.includes('/scripts/') && url.includes('/scenes')) {
        return json({
          items: [
            {
              id: 'scene1',
              script_id: 's1',
              ordinal: 1,
              title: 'Opening',
              summary: '',
              draft_md: '',
              status: 'planned',
              created_at: 0,
              updated_at: 0,
            },
          ],
        });
      }
      if (url.includes('/blogs/')) {
        return json({
          id: 'b1',
          title: 'My Blog',
          format: 'how-to',
          description: 'A blog',
          structure: null,
          planned_posts: 0,
          status: 'planning',
          emdash_site: null,
          created_at: 0,
          updated_at: 0,
          audience_json: [],
          voice_links_json: [],
          voice_uploads_json: [],
          voice_profile_md: '',
          rules_do_json: [],
          rules_dont_json: [],
        });
      }
      if (url.includes('/scripts/')) {
        return json({
          id: 's1',
          title: 'My Script',
          format: 'feature',
          logline: 'A hero rises',
          structure: null,
          planned_scenes: 0,
          status: 'planning',
          created_at: 0,
          updated_at: 0,
        });
      }
      if (url.includes('/session')) {
        return json({ user: { id: 'u1', email: 'w@example.com' } });
      }
      return json({});
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
  // The queryClient is a singleton shared across every test FILE (not just this
  // one). beforeEach mutated its default options for deterministic panel
  // renders; restore the app's real defaults + clear the cache afterward so the
  // mutation doesn't leak into other studio dom test files that rely on the
  // default retry:1 / staleTime behaviour (otherwise their fast-poll renders go
  // flaky under thread interleaving).
  queryClient.clear();
  queryClient.setDefaultOptions({ queries: { staleTime: 5_000, retry: 1 } });
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

function hrefs(): string[] {
  return Array.from(container!.querySelectorAll('a')).map((a) => a.getAttribute('href') ?? '');
}

describe('/studio/blogs/$blogId workspace (PR-5)', () => {
  it('mounts the blog workspace (post list) at /studio/blogs/$blogId', async () => {
    await mountAt('/studio/blogs/b1', () => (container?.textContent ?? '').includes('My Blog'));
    expect(assignSpy).not.toHaveBeenCalled();
    expect(container!.textContent ?? '').toContain('My Blog');
    // The first planned post is listed.
    expect(container!.textContent ?? '').toContain('First post');
    // The structure CTA links to the registered structure route...
    expect(hrefs()).toContain('/studio/blogs/b1/structure');
    // ...and the post edit link is a plain <a href> to the PR-6 editor.
    expect(hrefs()).toContain('/studio/blogs/b1/posts/post1');
  });

  it('mounts the structure picker at /studio/blogs/$blogId/structure', async () => {
    await mountAt('/studio/blogs/b1/structure', () =>
      (container?.textContent ?? '').includes('Structure the series'),
    );
    expect(assignSpy).not.toHaveBeenCalled();
    expect(container!.textContent ?? '').toContain('Structure the series');
  });
});

describe('/studio/scripts/$scriptId workspace (PR-5)', () => {
  it('mounts the script workspace (scene list) at /studio/scripts/$scriptId', async () => {
    await mountAt('/studio/scripts/s1', () =>
      (container?.textContent ?? '').includes('My Script'),
    );
    expect(assignSpy).not.toHaveBeenCalled();
    expect(container!.textContent ?? '').toContain('My Script');
    // The first planned scene is listed.
    expect(container!.textContent ?? '').toContain('Opening');
    // The structure CTA links to the registered structure route...
    expect(hrefs()).toContain('/studio/scripts/s1/structure');
    // ...and the scene edit link is a plain <a href> to the PR-6 editor.
    expect(hrefs()).toContain('/studio/scripts/s1/scenes/scene1');
  });

  it('mounts the structure picker at /studio/scripts/$scriptId/structure', async () => {
    await mountAt('/studio/scripts/s1/structure', () =>
      (container?.textContent ?? '').includes('Structure the script'),
    );
    expect(assignSpy).not.toHaveBeenCalled();
    expect(container!.textContent ?? '').toContain('Structure the script');
  });
});
