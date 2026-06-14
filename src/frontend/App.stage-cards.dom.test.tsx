// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import ReactDOM from 'react-dom/client';
import { act } from 'react-dom/test-utils';
import { MemoryRouter } from 'react-router-dom';
import App from './App';

(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let container: HTMLDivElement | null = null;
let root: ReactDOM.Root | null = null;

beforeEach(() => {
  vi.stubGlobal('fetch', vi.fn(async () => new Response('null', {
    status: 200,
    headers: { 'content-type': 'application/json' },
  })));
  window.sessionStorage.setItem('splash:seen', '1');
});

afterEach(() => {
  if (root) {
    act(() => { root!.unmount(); });
    root = null;
  }
  if (container) {
    container.remove();
    container = null;
  }
  vi.unstubAllGlobals();
});

async function mountAt(route: string): Promise<void> {
  container = document.createElement('div');
  document.body.appendChild(container);
  root = ReactDOM.createRoot(container);
  await act(async () => {
    root!.render(
      <MemoryRouter initialEntries={[route]}>
        <App />
      </MemoryRouter>,
    );
  });
  const yieldMacrotask = () => new Promise<void>((r) => setTimeout(r, 0));
  for (let i = 0; i < 50; i++) {
    await act(async () => { await yieldMacrotask(); });
    const heading = container!.querySelector('h1, h2');
    const onlyLoading = container!.textContent?.trim() === 'Loading…';
    if (heading && !onlyLoading) return;
  }
}

function getStartHereSection(): Element {
  const section = container!.querySelector('[aria-label="Get started"]');
  expect(section, '"Get started" section must be present on Home').not.toBeNull();
  return section!;
}

describe('Production pipeline stage cards', () => {
  it('renders all three stage cards in the "Start here" section on the home page', async () => {
    await mountAt('/');
    const section = getStartHereSection();
    expect(section.textContent).toContain('Pre-Production');
    expect(section.textContent).toContain('Production');
    expect(section.textContent).toContain('Post-Production');
  });

  it('Pre-Production card links internally to /words', async () => {
    await mountAt('/');
    const section = getStartHereSection();
    const links = Array.from(section.querySelectorAll('a'));
    const card = links.find((a) => a.textContent?.includes('Pre-Production'));
    expect(card, 'Pre-Production card must exist').not.toBeNull();
    expect(card!.getAttribute('href')).toBe('/words');
    expect(card!.getAttribute('aria-label')).toBeTruthy();
  });

  it('Production card links internally to /studio', async () => {
    await mountAt('/');
    const section = getStartHereSection();
    const links = Array.from(section.querySelectorAll('a'));
    const card = links.find(
      (a) =>
        a.textContent?.includes('Production') &&
        !a.textContent?.includes('Pre-') &&
        !a.textContent?.includes('Post-'),
    );
    expect(card, 'Production card must exist').not.toBeNull();
    expect(card!.getAttribute('href')).toBe('/studio');
    expect(card!.getAttribute('aria-label')).toBeTruthy();
  });

  it('Post-Production card opens reel-ez.com in a new tab with safe rel', async () => {
    await mountAt('/');
    const section = getStartHereSection();
    const links = Array.from(section.querySelectorAll('a'));
    const card = links.find((a) => a.textContent?.includes('Post-Production'));
    expect(card, 'Post-Production card must exist').not.toBeNull();
    expect(card!.getAttribute('href')).toBe('https://reel-ez.com/');
    expect(card!.getAttribute('target')).toBe('_blank');
    expect(card!.getAttribute('rel')).toBe('noopener noreferrer');
    expect(card!.getAttribute('aria-label')).toBeTruthy();
  });

  it('/words route renders the Words page', async () => {
    await mountAt('/words');
    const heading = container!.querySelector('h1');
    expect(heading?.textContent).toBe('Words');
  });
});
