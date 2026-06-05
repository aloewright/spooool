# AI Studio Chat UI (`/studio`) Implementation Plan — ALO-645

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development. Steps use checkbox (`- [ ]`) syntax.

**Goal:** Build the `/studio` chat page: a lazy, auth-gated React route that streams the AI Studio chat (ALO-644's `POST /api/studio/chat`) via `@tanstack/ai-react`'s `useChat` + an SSE connection adapter, rendered on-brand with the Strand design system.

**Architecture:** `pages/Studio.tsx` mirrors `pages/Create.tsx` gating (`useSession` → Spinner / `<Navigate to="/login">` / verify-email message), then renders `StudioRoot` from a new `src/frontend/studio/` module. `AIStudio` uses `useChat({ connection: studioChatConnection() })` where `studioChatConnection()` = `fetchServerSentEvents('/api/studio/chat', …)` from `@tanstack/ai-client`. The route is lazy-loaded and `@tanstack/ai*` is isolated into its own vendor chunk so it never enters the eager bundle.

**Tech Stack:** React 18 + Vite · react-router-dom · `@tanstack/ai-react` (`useChat`) + `@tanstack/ai-client` (`fetchServerSentEvents`) · Strand CSS (`src/frontend/styles/strand.css`) · vitest + happy-dom.

**Depends on:** ALO-644 (`POST /api/studio/chat`). This branch (`alo-645-studio-ui`) is stacked on `alo-644-studio-chat-route`. `@tanstack/ai-react` + `@tanstack/ai-client` were installed by ALO-642.

---

## Context an engineer needs
- **Gating to mirror — `src/frontend/pages/Create.tsx`:** `const { data: session, isPending } = useSession();` → `isPending` renders `<main className="app-main app-main--narrow stack-lg fade-in"><Spinner label="Loading session…"/></main>`; `!session` → `<Navigate to="/login" state={{ from: location.pathname }} replace />`; `session.user.emailVerified === false` → a verify-email `<main>` block; else render the page tree. Import `useSession` from `../lib/auth-client`, `Spinner` from `../create/Spinner`.
- **Strand classes (from `strand.css` + `create/AutoMode.tsx`):** `app-main app-main--narrow`, `card` / `card--tight`, `stack` / `stack-sm` / `stack-lg`, `btn btn--primary` / `btn--ghost` / `btn--secondary` / `btn--sm`, `input` (textarea uses `className="input"`), `field` / `field__label`, `alert alert--error` (role="alert"), `ds-h2` / `ds-lede` / `ds-meta` / `ds-empty`, `fade-in`. CSS vars: `--muted-foreground`, `--text-sm`, `--text-xs`. **Do not invent new classes** beyond small inline `style` tweaks like `AutoMode.tsx` does.
- **`useChat` API (`@tanstack/ai-react`):** `const { messages, sendMessage, isLoading, error, stop, clear } = useChat({ connection })`. `messages: UIMessage[]` (each has `role` + `parts`; extract text from parts where `type === 'text'` — read the `UIMessage` type in `@tanstack/ai-client` for the exact field, likely `part.text`). `sendMessage(content: string): Promise<void>`. `isLoading` true while a response streams. `error?: Error`.
- **SSE connection (`@tanstack/ai-client`):** `fetchServerSentEvents(url: string | (() => string), options?: FetchConnectionOptions | (() => …))`. Pass `() => ({ credentials: 'same-origin' as const })` so the session cookie is sent (same-origin → CSRF Origin check passes; spooool uses `credentials: 'same-origin'`, see `create-client.ts:51`).
- **Routing — `src/frontend/App.tsx`:** lazy pages declared like `const Create = lazy(() => import('./pages/Create').then((m) => ({ default: m.Create })));` (line ~48). Routes use `<Route path="/create" element={<RequireAuth><Create/></RequireAuth>} />` (line ~715). `HeaderNav()` (line ~190) renders signed-in nav as `<Link to="/x"><button type="button" className="btn btn--ghost btn--sm">Label</button></Link>`. Catch-all `<Route path="*" element={<NotFound/>}>` is last.
- **Chunking — `vite.config.ts`:** `manualChunks(id)` returns a chunk name for `node_modules` ids. Add an `@tanstack/ai` branch returning `'tanstack-ai'` BEFORE the `return 'vendor'`.
- **DOM test idiom — `src/frontend/pages/Subscriptions.dom.test.tsx`:** `// @vitest-environment happy-dom`, `ReactDOM.createRoot` + `act`, `MemoryRouter`, mock `globalThis.fetch`, `flush()` via `act(async () => { await Promise.resolve(); })`, assert `container.textContent`.

## File Structure
| File | Responsibility |
|---|---|
| `src/frontend/studio/lib/studio-client.ts` | `studioChatConnection()` → the `fetchServerSentEvents` SSE adapter for `/api/studio/chat` |
| `src/frontend/studio/AIStudio.tsx` | the chat component (`useChat`, message list, composer, states) |
| `src/frontend/studio/index.ts` | barrel: `export function StudioRoot()` rendering `<AIStudio/>` |
| `src/frontend/studio/AIStudio.dom.test.tsx` | happy-dom test: send a message, mock SSE, assert assistant text renders |
| `src/frontend/pages/Studio.tsx` | named `Studio` page; gating + renders `<StudioRoot/>` |
| `src/frontend/App.tsx` | lazy `Studio` + `/studio` route + HeaderNav link |
| `vite.config.ts` | isolate `@tanstack/ai*` into a `tanstack-ai` chunk |

---

### Task 1: `studio/` module — client, `AIStudio` component, barrel, DOM test

**Files:** create `studio/lib/studio-client.ts`, `studio/AIStudio.tsx`, `studio/index.ts`, `studio/AIStudio.dom.test.tsx`.

- [ ] **Step 1: `studio/lib/studio-client.ts`**
```ts
// SSE connection for the AI Studio chat endpoint (ALO-644's POST /api/studio/chat).
// credentials:'same-origin' sends the session cookie; same-origin keeps the CSRF
// Origin check happy. Used by AIStudio's useChat().
import { fetchServerSentEvents } from '@tanstack/ai-client';

export function studioChatConnection() {
  return fetchServerSentEvents('/api/studio/chat', () => ({ credentials: 'same-origin' as const }));
}
```

- [ ] **Step 2: `studio/AIStudio.tsx`** — the chat component
Build a focused, on-brand chat UI. Read the `UIMessage` type from `node_modules/@tanstack/ai-client` to extract message text (a small `messageText(m)` helper joining `m.parts` text). Requirements:
  - `const { messages, sendMessage, isLoading, error, clear } = useChat({ connection: studioChatConnection() });`
  - Local `input` state + a `<textarea className="input">`; submit on Enter (Shift+Enter = newline); a `btn btn--primary` send button `disabled={!input.trim() || isLoading}`.
  - On submit: `const text = input.trim(); if (!text) return; setInput(''); void sendMessage(text);`
  - Message list: map `messages` to rows with role label (`You` / `Studio`) and the extracted text; user vs assistant get distinct alignment/treatment via existing classes + minimal inline style (mirror AutoMode's inline-style approach — no new CSS classes). Render with `white-space: pre-wrap`.
  - Empty state when `messages.length === 0`: a `ds-empty`/`ds-meta` hint ("Ask for video ideas, titles, scripts, or thumbnails.").
  - While `isLoading`: show `<Spinner size={16} inline label="Studio is thinking…" />` (import from `../create/Spinner`) as a pending assistant row.
  - On `error`: an `alert alert--error` (role="alert") with `error.message` and a hint that the limit is 30 studio requests/hour (mirror AutoMode's 429 hint).
  - Auto-scroll the message list to the bottom on new messages (a `ref` + `useEffect`).
  - Accessibility: the composer is a `<form>`; the message log has `aria-live="polite"`.
  - Keep it ONE component (~120-160 lines). Named export `AIStudio`.

- [ ] **Step 3: `studio/index.ts`** (barrel)
```ts
import { AIStudio } from './AIStudio';
export function StudioRoot(): JSX.Element {
  return <AIStudio />;
}
```
(If JSX in a `.ts` file trips the build, name it `index.tsx`.)

- [ ] **Step 4: `studio/AIStudio.dom.test.tsx`** — write the streaming test
`// @vitest-environment happy-dom`. Mirror `Subscriptions.dom.test.tsx` (ReactDOM root + act + MemoryRouter + mock `globalThis.fetch` + `flush`). The test: mock `fetch` to return a `text/event-stream` `Response` whose body is the AG-UI event sequence for one assistant reply, type into the textarea, submit, flush, assert the assistant text renders.
```ts
function sseResponse(text: string): Response {
  const ev = (o: unknown) => `data: ${JSON.stringify(o)}\n\n`;
  const body =
    ev({ type: 'RUN_STARTED', runId: 'r1' }) +
    ev({ type: 'TEXT_MESSAGE_START', messageId: 'm1', role: 'assistant' }) +
    ev({ type: 'TEXT_MESSAGE_CONTENT', messageId: 'm1', delta: text }) +
    ev({ type: 'TEXT_MESSAGE_END', messageId: 'm1' }) +
    ev({ type: 'RUN_FINISHED', runId: 'r1' });
  return new Response(body, { status: 200, headers: { 'Content-Type': 'text/event-stream' } });
}
```
Mount `<MemoryRouter><StudioRoot/></MemoryRouter>`, set the textarea value + dispatch input event, submit the form (or click send), `await flush()` a few times (the stream is async), then assert `container.textContent` contains the assistant text. Also assert the user's typed text renders. **The exact AG-UI event shape that `useChat`/`StreamProcessor` needs to materialize an assistant message may differ from the guess above** — if the assistant text doesn't render, read `node_modules/@tanstack/ai-client/dist/esm/connection-adapters.js` + `StreamProcessor` to get the required event fields (e.g. whether `TEXT_MESSAGE_START` needs `role`, whether `messageId` must thread through), and adjust the mock until the real `useChat` renders it. Do NOT mock `useChat` itself — the point is to exercise the real hook against a mocked SSE body.

- [ ] **Step 5: Run + commit**
`npx vitest run src/frontend/studio/AIStudio.dom.test.tsx` (green), `npm run type-check` (exit 0), `npm run lint:no-providers` (0 findings). Then:
```bash
git add src/frontend/studio
git commit -m "feat(studio): AI Studio chat component + SSE useChat client + DOM test"
```

---

### Task 2: `/studio` page + routing + chunk-split + full verify

**Files:** create `pages/Studio.tsx`; modify `App.tsx`, `vite.config.ts`.

- [ ] **Step 1: `pages/Studio.tsx`** — gating mirror of `Create.tsx`
```tsx
import { Navigate, useLocation } from 'react-router-dom';
import { useSession } from '../lib/auth-client';
import { StudioRoot } from '../studio';
import { Spinner } from '../create/Spinner';

export function Studio(): JSX.Element {
  const location = useLocation();
  const { data: session, isPending } = useSession();
  if (isPending) {
    return (
      <main className="app-main app-main--narrow stack-lg fade-in" style={{ padding: 24 }}>
        <Spinner label="Loading session…" />
      </main>
    );
  }
  if (!session) return <Navigate to="/login" state={{ from: location.pathname }} replace />;
  if (session.user.emailVerified === false) {
    return (
      <main className="app-main app-main--narrow stack-lg fade-in">
        <h1 className="ds-h2">Verify your email to use the studio</h1>
        <p>The AI Studio is unlocked after you confirm your email.</p>
      </main>
    );
  }
  return (
    <main className="app-main app-main--narrow stack-lg fade-in">
      <h1 className="ds-h2">AI Studio</h1>
      <p className="ds-lede">Brainstorm ideas, titles, scripts, and thumbnails with a creative assistant.</p>
      <StudioRoot />
    </main>
  );
}
```

- [ ] **Step 2: Wire `App.tsx`**
- Add lazy import near the `Create` one: `const Studio = lazy(() => import('./pages/Studio').then((m) => ({ default: m.Studio })));`
- Add the route near `/create`: `<Route path="/studio" element={<RequireAuth><Studio /></RequireAuth>} />`
- In `HeaderNav()` (signed-in branch), add a nav link mirroring the others: `<Link to="/studio"><button type="button" className="btn btn--ghost btn--sm">Studio</button></Link>` (place near the Create/Subscriptions entries).

- [ ] **Step 3: Isolate `@tanstack/ai*` in `vite.config.ts`**
In `manualChunks`, add before `return 'vendor';`:
```ts
// @tanstack/ai* (ai-react + ai-client) is only loaded by the lazy /studio
// route — keep it out of the eager vendor chunk.
if (id.includes('@tanstack/ai')) return 'tanstack-ai';
```

- [ ] **Step 4: Full verify**
`npm run type-check` (exit 0), `npx vitest run src/frontend/studio/AIStudio.dom.test.tsx` (green), `npm run lint` (0 errors) + `npm run lint:no-providers` (0 findings), `npm run build` (exit 0). After build, confirm a `tanstack-ai-*.js` chunk exists in `dist/assets` and the eager `vendor` chunk does NOT contain `@tanstack/ai` (e.g. `grep -l "tanstack" dist/assets/tanstack-ai-*.js` exists; spot-check `vendor` size didn't balloon).

- [ ] **Step 5: Commit**
```bash
git add src/frontend/pages/Studio.tsx src/frontend/App.tsx vite.config.ts
git commit -m "feat(studio): add /studio lazy route + nav + tanstack-ai chunk split"
```

---

## Acceptance criteria (ALO-645) → task mapping
- [ ] `/studio` is a lazy route gated on session + emailVerified — Task 2.
- [ ] `useChat` consumes the SSE endpoint and renders streamed tokens — Task 1 (component + DOM test).
- [ ] `@tanstack/ai*` is in its own vendor chunk (not eager `vendor`) — Task 2 Step 3 + verify.
- [ ] DOM test drives a fake SSE stream and asserts message render — Task 1 Step 4.

## Notes
- Don't mock `useChat` in the DOM test — exercise the real hook against a mocked SSE body so the streaming path is genuinely covered.
- In the default run-gateway transport (server side), the assistant reply may arrive as one `TEXT_MESSAGE_CONTENT` chunk rather than token-by-token; the UI renders either identically.
- No tools / image / video here — chat only (ALO-646/647 add those panels to this module later).
- Devtools (`?debug=1`) is ALO-651, not here.
