# Prompt-to-Video Agent Architecture Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Ship sub-project #4: a `/create` page that turns a user prompt into a finished animated explainer video via Cloudflare Managed Agents (one-shot) or Cloudflare Agents SDK Durable Object (guided Q&A), reusing the existing render pipeline from sub-#1.

**Architecture:** Two agent runtimes (CMA + ComposerAgent DO) call a shared set of worker-local tools (`draft_script`, `plan_scenes`, `synthesize_tts`, `finalize_render`). Tools wrap AI Gateway `dynamic/*` routes and hand off to the existing `submitRenderJob()` (extracted from sub-#1's `render.ts`). A new Remotion composition `spooool-explainer` renders the result through the same container.

**Tech Stack:** Hono on Cloudflare Workers, Cloudflare D1 + R2 + Durable Objects + Containers + AI Gateway + Managed Agents, Cloudflare Agents SDK, Remotion 4, React 18 + Vite + React Router, `vitest`, Playwright.

**Source-of-truth references:**
- Spec: `docs/superpowers/specs/2026-05-27-prompt-to-video-design.md`
- Sub-#1 render pipeline: `docs/superpowers/specs/2026-05-26-recorder-pipeline-design.md`
- AI Gateway dynamic routes guidance: top of `~/.claude/CLAUDE.md`
- Existing handler being refactored: `src/workers/render.ts:33` (the `POST /api/render/jobs` body)
- Existing migration pattern: `src/db/migrations/0020_render_jobs.sql`
- Existing worker route pattern: `src/workers/lifecycle.ts`
- Existing DO patterns: `src/workers/rate-limit-do.ts`, `src/workers/channel-do.ts`
- Existing Remotion composition: `container/render/remotion/SpoooolVideo.tsx`

---

## Phase A — Sub-#1 refactor (`submitRenderJob` extraction)

### Task 1: Extract `submitRenderJob` from the existing render.ts handler

**Files:**
- Modify: `src/workers/render.ts` (extract function, keep HTTP handler thin)
- Modify: `src/workers/render.test.ts` (existing tests still pass, plus one new direct-call test)

- [ ] **Step 1: Write a failing test for direct `submitRenderJob` call**

In `src/workers/render.test.ts`, append after the existing `POST /api/render/jobs` describe block:

```ts
describe('submitRenderJob (direct call)', () => {
  it('inserts a render_jobs row, dispatches the container, returns jobId', async () => {
    const { submitRenderJob } = await import('./render');
    const env = envFor();
    const result = await submitRenderJob({
      userId: 'u_direct',
      takeKeys: ['recorder/raw/u_direct/s/take_001.webm'],
      compositionProps: { title: 'direct call' },
      env,
    });
    expect(result.jobId).toMatch(/^j_/);
    const rows = [...((env.DB as unknown as { rows: Map<string, { user_id: string }> }).rows.values())];
    expect(rows).toHaveLength(1);
    expect(rows[0].user_id).toBe('u_direct');
    const calls = (env.RENDER_CONTAINER as unknown as { _calls: Array<{ id: string }> })._calls;
    expect(calls).toHaveLength(1);
    expect(calls[0].id).toBe('u_direct');
  });

  it('throws when container dispatch fails, leaving the job marked failed', async () => {
    const { submitRenderJob } = await import('./render');
    const env = envFor();
    (env.RENDER_CONTAINER as unknown as { get: () => { fetch: () => Promise<Response> } }).get = () => ({
      fetch: async () => new Response('{"error":"x"}', { status: 500 }),
    });
    await expect(
      submitRenderJob({ userId: 'u_x', takeKeys: ['k'], compositionProps: {}, env }),
    ).rejects.toThrow(/Container responded 500/);
    const rows = [...((env.DB as unknown as { rows: Map<string, { status: string }> }).rows.values())];
    expect(rows[0].status).toBe('failed');
  });
});
```

- [ ] **Step 2: Run tests to verify the new ones fail**

Run: `npx vitest run src/workers/render.test.ts`
Expected: 2 new failures (`submitRenderJob not exported`). Existing tests still pass.

- [ ] **Step 3: Implement `submitRenderJob` and rewrite the route handler to call it**

In `src/workers/render.ts`, replace the existing `renderRoutes.post('/api/render/jobs', ...)` handler with this two-part block. Keep all other routes and helpers (callbacks, sweep, timing-safe compare) untouched.

```ts
export interface SubmitRenderJobInput {
  userId: string;
  takeKeys: string[];
  compositionProps: Record<string, unknown>;
  env: RenderEnv;
}

export async function submitRenderJob(input: SubmitRenderJobInput): Promise<{ jobId: string }> {
  const jobId = `j_${crypto.randomUUID().replace(/-/g, '').slice(0, 16)}`;
  const now = Date.now();
  await input.env.DB.prepare(
    `INSERT INTO render_jobs (id, user_id, status, composition_spec, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)`,
  ).bind(jobId, input.userId, 'queued', JSON.stringify({ takeKeys: input.takeKeys, compositionProps: input.compositionProps }), now, now).run();

  const ct = input.env.RENDER_CONTAINER.get(input.env.RENDER_CONTAINER.idFromName(input.userId));
  try {
    const res = await ct.fetch('https://render-container/render', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ jobId, takeKeys: input.takeKeys, compositionProps: input.compositionProps }),
    });
    if (!res.ok) {
      const responseBody = await res.text().catch(() => '<unreadable>');
      console.error(`[render] container dispatch ${res.status} jobId=${jobId} body=${responseBody.slice(0, 500)}`);
      throw new Error(`Container responded ${res.status}: ${responseBody.slice(0, 200)}`);
    }
  } catch (err) {
    await input.env.DB.prepare(
      `UPDATE render_jobs SET status='failed', error_message=?, updated_at=? WHERE id=?`,
    ).bind(`Container dispatch failed: ${err instanceof Error ? err.message : String(err)}`, Date.now(), jobId).run();
    throw err;
  }
  return { jobId };
}

renderRoutes.post('/api/render/jobs', async (c) => {
  const user = c.get('user');
  if (!user) return c.json({ error: 'Unauthorized' }, 401);
  const raw = await c.req.json().catch(() => null);
  const parsed = createBodySchema.safeParse(raw);
  if (!parsed.success) {
    return c.json({ error: 'Invalid body', details: parsed.error.flatten() }, 400);
  }
  try {
    const { jobId } = await submitRenderJob({
      userId: user.id,
      takeKeys: parsed.data.takeKeys,
      compositionProps: parsed.data.compositionProps as Record<string, unknown>,
      env: c.env,
    });
    return c.json({ jobId });
  } catch {
    return c.json({ error: 'Render service unavailable' }, 503, { 'Retry-After': '60' });
  }
});
```

- [ ] **Step 4: Run all render tests to confirm green**

Run: `npx vitest run src/workers/render.test.ts`
Expected: PASS — original tests + 2 new direct-call tests.

- [ ] **Step 5: Commit**

```bash
git add src/workers/render.ts src/workers/render.test.ts
git commit -m "refactor(render): extract submitRenderJob from POST /api/render/jobs"
```

---

## Phase B — D1 migration + template registry

### Task 2: `create_sessions` migration

**Files:**
- Create: `src/db/migrations/0021_create_sessions.sql`

- [ ] **Step 1: Write the migration**

```sql
-- Sub-project #4 of recorder + render pipeline. Holds per-session state
-- for the guided (Composer DO) creation mode. Auto-mode skips this table
-- and writes straight to render_jobs.
--
-- States:
--   questioning: DO is walking the user through the template's Q&A
--   rendering:   user clicked "Generate"; toolchain is running
--   completed:   render_jobs.status='completed' and video_id is set
--   failed:      either the agent or the render failed
--   abandoned:   no activity for 24h while still in 'questioning'

CREATE TABLE IF NOT EXISTS create_sessions (
  id TEXT PRIMARY KEY NOT NULL,
  user_id TEXT NOT NULL,
  template_id TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('questioning','rendering','completed','failed','abandoned')),
  answers TEXT NOT NULL DEFAULT '{}',
  job_id TEXT,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  FOREIGN KEY (user_id) REFERENCES user(id),
  FOREIGN KEY (job_id) REFERENCES render_jobs(id)
);

CREATE INDEX IF NOT EXISTS idx_create_sessions_user_status ON create_sessions(user_id, status);
CREATE INDEX IF NOT EXISTS idx_create_sessions_stuck ON create_sessions(status, updated_at);
```

- [ ] **Step 2: Apply locally**

Run: `npx wrangler d1 migrations apply spooool-prod --local`
Expected: `0021_create_sessions.sql ✅`.

- [ ] **Step 3: Commit**

```bash
git add src/db/migrations/0021_create_sessions.sql
git commit -m "feat(db): add create_sessions for prompt-to-video guided mode"
```

### Task 3: Template types + hero-journey definition

**Files:**
- Create: `src/workers/create/templates/types.ts`
- Create: `src/workers/create/templates/hero-journey.ts`
- Create: `src/workers/create/templates/index.ts`
- Create: `src/workers/create/templates/index.test.ts`

- [ ] **Step 1: Write the failing test**

```ts
// src/workers/create/templates/index.test.ts
import { describe, expect, it } from 'vitest';
import { TEMPLATES, getTemplate, listTemplateMetadata } from './index';

describe('templates registry', () => {
  it('exposes hero-journey with all required fields', () => {
    const t = getTemplate('hero-journey');
    expect(t).not.toBeNull();
    expect(t!.id).toBe('hero-journey');
    expect(t!.questions.length).toBeGreaterThanOrEqual(5);
    expect(t!.scenePlan.length).toBeGreaterThan(0);
    expect(t!.voice.profile).toBe('warm');
    expect(t!.voice.pacingWpm).toBe(150);
    expect(t!.systemPromptFragment.length).toBeGreaterThan(40);
    for (const q of t!.questions) {
      expect(q.id).toMatch(/^[a-z][a-z0-9-]*$/);
      expect(q.text.length).toBeGreaterThan(8);
    }
  });

  it('listTemplateMetadata strips question text', () => {
    const meta = listTemplateMetadata();
    expect(meta).toHaveLength(1);
    expect(meta[0].id).toBe('hero-journey');
    expect((meta[0] as unknown as { questions?: unknown }).questions).toBeUndefined();
  });

  it('getTemplate returns null for unknown id', () => {
    expect(getTemplate('made-up')).toBeNull();
  });
});
```

- [ ] **Step 2: Run, confirm failure**

Run: `npx vitest run src/workers/create/templates/index.test.ts`
Expected: FAIL ("Cannot find module './index'").

- [ ] **Step 3: Implement types.ts**

```ts
// src/workers/create/templates/types.ts
export interface Question {
  id: string;
  text: string;
  hint?: string;
  multiline?: boolean;
}

export interface ScenePlanHint {
  beatId: string;
  questionIds: string[];
  durationSeconds: number;
}

export type VoiceProfile = 'neutral' | 'warm' | 'energetic';

export interface StoryTemplate {
  id: string;
  name: string;
  description: string;
  questions: Question[];
  systemPromptFragment: string;
  scenePlan: ScenePlanHint[];
  voice: { profile: VoiceProfile; pacingWpm: number };
}

export interface TemplateMetadata {
  id: string;
  name: string;
  description: string;
}
```

- [ ] **Step 4: Implement hero-journey.ts**

```ts
// src/workers/create/templates/hero-journey.ts
import type { StoryTemplate } from './types';

export const heroJourney: StoryTemplate = {
  id: 'hero-journey',
  name: "The Hero's Journey",
  description: 'A short narrative arc — ordinary world → call to adventure → transformation. Best for 60-90 second character-driven explainers.',
  questions: [
    { id: 'protagonist', text: 'Who is the protagonist? (one sentence)', hint: 'e.g., a new developer learning Cloudflare Workers' },
    { id: 'ordinary-world', text: 'What is their ordinary world before things change?' },
    { id: 'inciting-incident', text: 'What forces them out of that ordinary world?' },
    { id: 'false-belief', text: 'What false belief or lie were they operating under?' },
    { id: 'turning-point', text: 'What pressure forces them to confront the truth?' },
    { id: 'transformation', text: 'What does the protagonist look like after the change?' },
    { id: 'closing-truth', text: 'What single line should the viewer remember?', hint: 'a punchy takeaway' },
  ],
  systemPromptFragment:
    "You are writing a 60-90 second narrative explainer following the hero's journey arc. Keep the language vivid and concrete; one beat per scene. Use second-person ('you') only if it fits the answers.",
  scenePlan: [
    { beatId: 'ordinary-world', questionIds: ['protagonist', 'ordinary-world'], durationSeconds: 10 },
    { beatId: 'call-to-adventure', questionIds: ['inciting-incident'], durationSeconds: 10 },
    { beatId: 'tension', questionIds: ['false-belief', 'turning-point'], durationSeconds: 20 },
    { beatId: 'transformation', questionIds: ['transformation'], durationSeconds: 15 },
    { beatId: 'outro', questionIds: ['closing-truth'], durationSeconds: 8 },
  ],
  voice: { profile: 'warm', pacingWpm: 150 },
};
```

- [ ] **Step 5: Implement index.ts**

```ts
// src/workers/create/templates/index.ts
import { heroJourney } from './hero-journey';
import type { StoryTemplate, TemplateMetadata } from './types';

export const TEMPLATES: Record<string, StoryTemplate> = {
  [heroJourney.id]: heroJourney,
};

export function getTemplate(id: string): StoryTemplate | null {
  return TEMPLATES[id] ?? null;
}

export function listTemplateMetadata(): TemplateMetadata[] {
  return Object.values(TEMPLATES).map((t) => ({
    id: t.id,
    name: t.name,
    description: t.description,
  }));
}

export type { StoryTemplate, TemplateMetadata, Question, ScenePlanHint, VoiceProfile } from './types';
```

- [ ] **Step 6: Run tests, confirm pass**

Run: `npx vitest run src/workers/create/templates/index.test.ts`
Expected: PASS, 3/3.

- [ ] **Step 7: Commit**

```bash
git add src/workers/create/templates/
git commit -m "feat(create): template types + hero-journey definition"
```

---

## Phase C — Worker tools

### Task 4: `draftScript` and `planScenes` tools (LLM tools)

**Files:**
- Create: `src/workers/create-tools.ts`
- Create: `src/workers/create-tools.test.ts`

- [ ] **Step 1: Write failing tests for both LLM tools**

```ts
// src/workers/create-tools.test.ts
import { describe, expect, it, vi, afterEach } from 'vitest';
import { draftScript, planScenes, type AIGatewayEnv } from './create-tools';
import { heroJourney } from './create/templates/hero-journey';

const originalFetch = globalThis.fetch;
afterEach(() => { globalThis.fetch = originalFetch; });

function mockGateway(impl: (path: string, init: RequestInit) => Promise<Response>) {
  globalThis.fetch = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof input === 'string' ? input : input.toString();
    return impl(url, init ?? {});
  }) as unknown as typeof fetch;
}

function envFor(): AIGatewayEnv {
  return {
    CF_ACCOUNT_ID: 'acc_test',
    CF_GATEWAY_ID: 'x',
    CF_AIG_TOKEN: 'tok_test',
  };
}

describe('draftScript', () => {
  it('calls dynamic/text_gen with the template system prompt and returns the script', async () => {
    let seenBody: { model: string; messages: Array<{ role: string; content: string }> } | null = null;
    mockGateway(async (url, init) => {
      seenBody = JSON.parse(init.body as string);
      return new Response(JSON.stringify({ choices: [{ message: { content: 'Once upon a time in the ordinary world…' } }] }), { status: 200 });
    });
    const result = await draftScript({
      template: heroJourney,
      answers: { protagonist: 'a junior dev', 'ordinary-world': 'a quiet startup' },
      env: envFor(),
    });
    expect(result.script).toMatch(/Once upon a time/);
    expect(seenBody!.model).toBe('dynamic/text_gen');
    expect(seenBody!.messages[0].content).toContain("hero's journey");
  });

  it('caps the returned script to 1500 chars', async () => {
    mockGateway(async () => new Response(JSON.stringify({ choices: [{ message: { content: 'x'.repeat(5000) } }] }), { status: 200 }));
    const result = await draftScript({ template: heroJourney, answers: {}, env: envFor() });
    expect(result.script.length).toBe(1500);
  });

  it('retries twice on 5xx and surfaces the provider message on final failure', async () => {
    let calls = 0;
    mockGateway(async () => { calls++; return new Response('upstream down', { status: 503 }); });
    await expect(draftScript({ template: heroJourney, answers: {}, env: envFor() })).rejects.toThrow(/Script generation failed/);
    expect(calls).toBe(3); // initial + 2 retries
  });
});

describe('planScenes', () => {
  it('returns parsed scenes array from a JSON response', async () => {
    const fakeScenes = [
      { type: 'title', durationFrames: 90, text: 'Hello world' },
      { type: 'beat', durationFrames: 120, text: 'Then everything changed' },
    ];
    mockGateway(async () => new Response(JSON.stringify({ choices: [{ message: { content: JSON.stringify({ scenes: fakeScenes }) } }] }), { status: 200 }));
    const result = await planScenes({ script: 'Once upon a time…', template: heroJourney, env: envFor() });
    expect(result.scenes).toEqual(fakeScenes);
  });

  it('re-prompts once on malformed JSON, then throws', async () => {
    let calls = 0;
    mockGateway(async () => {
      calls++;
      return new Response(JSON.stringify({ choices: [{ message: { content: 'not json at all' } }] }), { status: 200 });
    });
    await expect(planScenes({ script: 'x', template: heroJourney, env: envFor() })).rejects.toThrow(/Scene plan invalid/);
    expect(calls).toBe(2); // initial + 1 reprompt
  });

  it('caps scenes to 20 even when the LLM returns more', async () => {
    const many = Array.from({ length: 50 }, (_, i) => ({ type: 'beat', durationFrames: 60, text: `s${i}` }));
    mockGateway(async () => new Response(JSON.stringify({ choices: [{ message: { content: JSON.stringify({ scenes: many }) } }] }), { status: 200 }));
    const result = await planScenes({ script: 'x', template: heroJourney, env: envFor() });
    expect(result.scenes).toHaveLength(20);
  });
});
```

- [ ] **Step 2: Run, confirm failure**

Run: `npx vitest run src/workers/create-tools.test.ts`
Expected: FAIL ("Cannot find module './create-tools'").

- [ ] **Step 3: Implement the file with both tools**

```ts
// src/workers/create-tools.ts
//
// Tool implementations for the prompt-to-video agent (sub-project #4).
// Each tool wraps an AI Gateway dynamic route per CLAUDE.md's "never call
// providers directly" rule. Pure of side effects beyond the explicit
// network / R2 calls so unit tests can mock fetch.

import type { StoryTemplate, VoiceProfile } from './create/templates/types';

export interface AIGatewayEnv {
  CF_ACCOUNT_ID: string;
  CF_GATEWAY_ID: string;
  CF_AIG_TOKEN: string;
}

export interface SceneSpec {
  type: 'title' | 'beat' | 'outro';
  durationFrames: number;
  text: string;
  subtitle?: string;
}

const MAX_SCRIPT_CHARS = 1500;
const MAX_SCENES = 20;

function gatewayUrl(env: AIGatewayEnv): string {
  return `https://gateway.ai.cloudflare.com/v1/${env.CF_ACCOUNT_ID}/${env.CF_GATEWAY_ID}/compat/chat/completions`;
}

function gatewayHeaders(env: AIGatewayEnv): Record<string, string> {
  return {
    'content-type': 'application/json',
    'cf-aig-authorization': `Bearer ${env.CF_AIG_TOKEN}`,
    'cf-aig-zdr': 'true',
  };
}

async function chatComplete(
  args: { route: 'dynamic/text_gen' | 'dynamic/research_gen'; messages: Array<{ role: 'system' | 'user'; content: string }>; env: AIGatewayEnv },
  retries: number,
): Promise<string> {
  let lastErr: unknown = null;
  for (let attempt = 0; attempt <= retries; attempt++) {
    const res = await fetch(gatewayUrl(args.env), {
      method: 'POST',
      headers: gatewayHeaders(args.env),
      body: JSON.stringify({ model: args.route, messages: args.messages }),
    });
    if (res.ok) {
      const body = (await res.json()) as { choices?: Array<{ message?: { content?: string } }> };
      const content = body.choices?.[0]?.message?.content;
      if (typeof content === 'string') return content;
      lastErr = new Error('AI Gateway returned no message content');
    } else {
      lastErr = new Error(`AI Gateway ${res.status}`);
      if (res.status < 500) break; // don't retry 4xx
    }
    if (attempt < retries) await new Promise((r) => setTimeout(r, 500 * (attempt + 1)));
  }
  throw lastErr instanceof Error ? lastErr : new Error('AI Gateway call failed');
}

export async function draftScript(args: {
  template: StoryTemplate;
  answers: Record<string, string>;
  env: AIGatewayEnv;
}): Promise<{ script: string }> {
  const answersBlock = Object.entries(args.answers)
    .map(([qid, a]) => `Q[${qid}]: ${a}`)
    .join('\n');
  const messages = [
    {
      role: 'system' as const,
      content: `${args.template.systemPromptFragment}\nProduce only the narration text, no scene headers, no markdown.`,
    },
    { role: 'user' as const, content: answersBlock || 'No answers provided; invent plausible details consistent with the template.' },
  ];
  let content: string;
  try {
    content = await chatComplete({ route: 'dynamic/text_gen', messages, env: args.env }, 2);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    throw new Error(`Script generation failed: ${msg}`);
  }
  return { script: content.slice(0, MAX_SCRIPT_CHARS) };
}

export async function planScenes(args: {
  script: string;
  template: StoryTemplate;
  env: AIGatewayEnv;
}): Promise<{ scenes: SceneSpec[] }> {
  const messages = [
    {
      role: 'system' as const,
      content:
        `${args.template.systemPromptFragment}\nReturn ONLY a JSON object of shape { "scenes": [{ "type": "title"|"beat"|"outro", "durationFrames": number, "text": string, "subtitle"?: string }] }. Use 30fps; the sum of durationFrames must be 1800-2700 (60-90 seconds). Do NOT include any commentary outside the JSON.`,
    },
    { role: 'user' as const, content: `Script:\n${args.script}\n\nTemplate scene plan hints:\n${JSON.stringify(args.template.scenePlan)}` },
  ];

  const parseOrThrow = (raw: string): SceneSpec[] => {
    const parsed = JSON.parse(raw) as { scenes?: unknown };
    if (!parsed || !Array.isArray(parsed.scenes)) throw new Error('missing scenes array');
    return parsed.scenes.slice(0, MAX_SCENES).map((s) => {
      const obj = s as { type?: unknown; durationFrames?: unknown; text?: unknown; subtitle?: unknown };
      if (obj.type !== 'title' && obj.type !== 'beat' && obj.type !== 'outro') throw new Error('bad scene type');
      if (typeof obj.durationFrames !== 'number' || !Number.isFinite(obj.durationFrames)) throw new Error('bad durationFrames');
      if (typeof obj.text !== 'string') throw new Error('bad text');
      return {
        type: obj.type,
        durationFrames: Math.max(1, Math.floor(obj.durationFrames)),
        text: obj.text,
        subtitle: typeof obj.subtitle === 'string' ? obj.subtitle : undefined,
      };
    });
  };

  const tryOnce = async (): Promise<SceneSpec[]> => {
    const raw = await chatComplete({ route: 'dynamic/text_gen', messages, env: args.env }, 0);
    return parseOrThrow(raw);
  };

  try {
    return { scenes: await tryOnce() };
  } catch (firstErr) {
    try {
      return { scenes: await tryOnce() };
    } catch (secondErr) {
      const msg = secondErr instanceof Error ? secondErr.message : String(secondErr);
      throw new Error(`Scene plan invalid: ${msg}`);
    }
  }
}

// Re-export VoiceProfile for downstream tools / tests.
export type { VoiceProfile };
```

- [ ] **Step 4: Run tests, confirm pass**

Run: `npx vitest run src/workers/create-tools.test.ts`
Expected: PASS, 6/6.

- [ ] **Step 5: Commit**

```bash
git add src/workers/create-tools.ts src/workers/create-tools.test.ts
git commit -m "feat(create): draft_script + plan_scenes tools (AI Gateway text_gen)"
```

### Task 5: `synthesizeTts` tool (audio_gen + R2 upload)

**Files:**
- Modify: `src/workers/create-tools.ts` (append `synthesizeTts`)
- Modify: `src/workers/create-tools.test.ts` (append TTS tests)

- [ ] **Step 1: Write failing tests**

Append to `create-tools.test.ts`:

```ts
import { synthesizeTts, type R2BindingEnv } from './create-tools';

describe('synthesizeTts', () => {
  function r2Env(): R2BindingEnv {
    const puts: Array<{ key: string; bytes: number; contentType?: string }> = [];
    const VIDEOS = {
      put: async (key: string, body: ArrayBuffer | ReadableStream, opts?: { httpMetadata?: { contentType?: string } }) => {
        const bytes = body instanceof ArrayBuffer ? body.byteLength : -1;
        puts.push({ key, bytes, contentType: opts?.httpMetadata?.contentType });
      },
    } as unknown as R2Bucket;
    (VIDEOS as unknown as { _puts: typeof puts })._puts = puts;
    return { VIDEOS };
  }

  it('calls dynamic/audio_gen, writes mp3 to recorder/tts/{jobId}.mp3, returns key + durationMs', async () => {
    const audioBytes = new Uint8Array([0xff, 0xfb, 0x90, 0x00]); // tiny fake mp3 header bytes
    mockGateway(async (url) => {
      expect(url).toContain('/audio/speech');
      return new Response(audioBytes, { status: 200, headers: { 'content-type': 'audio/mpeg' } });
    });
    const env = { ...envFor(), ...r2Env() };
    const result = await synthesizeTts({
      script: 'Hello world.',
      voice: { profile: 'warm', pacingWpm: 150 },
      jobId: 'j_abc',
      env,
    });
    expect(result.r2Key).toBe('recorder/tts/j_abc.mp3');
    expect(result.durationMs).toBeGreaterThan(0);
    const puts = (env.VIDEOS as unknown as { _puts: Array<{ key: string; contentType?: string }> })._puts;
    expect(puts[0]).toMatchObject({ key: 'recorder/tts/j_abc.mp3', contentType: 'audio/mpeg' });
  });

  it('rejects scripts longer than 2000 chars before calling the gateway', async () => {
    const env = { ...envFor(), ...r2Env() };
    mockGateway(async () => new Response('should not be called', { status: 200 }));
    await expect(
      synthesizeTts({ script: 'x'.repeat(2001), voice: { profile: 'warm', pacingWpm: 150 }, jobId: 'j_x', env }),
    ).rejects.toThrow(/script too long/i);
  });

  it('masks content-policy refusals with a generic message', async () => {
    mockGateway(async () => new Response(JSON.stringify({ error: { code: 'content_policy_violation', message: 'forbidden' } }), { status: 400 }));
    const env = { ...envFor(), ...r2Env() };
    await expect(
      synthesizeTts({ script: 'hi', voice: { profile: 'warm', pacingWpm: 150 }, jobId: 'j_y', env }),
    ).rejects.toThrow(/Generation failed, please try rephrasing/);
  });
});
```

- [ ] **Step 2: Run, confirm failure**

Run: `npx vitest run src/workers/create-tools.test.ts`
Expected: FAIL (3 new tests).

- [ ] **Step 3: Implement `synthesizeTts`**

Append to `src/workers/create-tools.ts`:

```ts
export interface R2BindingEnv {
  VIDEOS: R2Bucket;
}

const MAX_TTS_CHARS = 2000;

function audioRouteUrl(env: AIGatewayEnv): string {
  return `https://gateway.ai.cloudflare.com/v1/${env.CF_ACCOUNT_ID}/${env.CF_GATEWAY_ID}/compat/audio/speech`;
}

function isContentPolicyResponse(body: string): boolean {
  return /content[_ ]policy|safety/i.test(body);
}

export async function synthesizeTts(args: {
  script: string;
  voice: { profile: VoiceProfile; pacingWpm: number };
  jobId: string;
  env: AIGatewayEnv & R2BindingEnv;
}): Promise<{ r2Key: string; durationMs: number }> {
  if (args.script.length > MAX_TTS_CHARS) throw new Error('script too long for TTS');

  const payload = {
    model: 'dynamic/audio_gen',
    voice: args.voice.profile,
    input: args.script,
    response_format: 'mp3',
  };

  let res: Response | null = null;
  let lastErr: string = '';
  for (let attempt = 0; attempt <= 1; attempt++) {
    res = await fetch(audioRouteUrl(args.env), {
      method: 'POST',
      headers: gatewayHeaders(args.env),
      body: JSON.stringify(payload),
    });
    if (res.ok && res.headers.get('content-type')?.includes('audio')) break;
    const text = await res.clone().text().catch(() => '');
    lastErr = text;
    if (res.status >= 400 && res.status < 500) {
      if (isContentPolicyResponse(text)) {
        console.error('[create-tools] tts content-policy refusal', text.slice(0, 500));
        throw new Error('Generation failed, please try rephrasing your prompt.');
      }
      break; // other 4xx — don't retry
    }
    if (attempt < 1) await new Promise((r) => setTimeout(r, 500));
  }

  if (!res || !res.ok || !res.headers.get('content-type')?.includes('audio')) {
    throw new Error(`TTS synthesis failed: ${lastErr.slice(0, 200)}`);
  }

  const audioBytes = await res.arrayBuffer();
  const r2Key = `recorder/tts/${args.jobId}.mp3`;

  // Upload with 3x exponential backoff.
  let putErr: unknown = null;
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      await args.env.VIDEOS.put(r2Key, audioBytes, { httpMetadata: { contentType: 'audio/mpeg' } });
      putErr = null;
      break;
    } catch (err) {
      putErr = err;
      await new Promise((r) => setTimeout(r, 250 * 2 ** attempt));
    }
  }
  if (putErr) throw new Error(`TTS upload failed: ${putErr instanceof Error ? putErr.message : String(putErr)}`);

  // Estimate duration from script length + pacing (we don't decode the mp3 here;
  // the renderer will use the actual audio file length).
  const words = args.script.trim().split(/\s+/).length;
  const durationMs = Math.round((words / args.voice.pacingWpm) * 60_000);

  return { r2Key, durationMs };
}
```

- [ ] **Step 4: Run tests, confirm pass**

Run: `npx vitest run src/workers/create-tools.test.ts`
Expected: PASS for all (6 prior + 3 new = 9).

- [ ] **Step 5: Commit**

```bash
git add src/workers/create-tools.ts src/workers/create-tools.test.ts
git commit -m "feat(create): synthesize_tts tool (AI Gateway audio_gen → R2)"
```

### Task 6: `finalizeRender` tool

**Files:**
- Modify: `src/workers/create-tools.ts` (append `finalizeRender`)
- Modify: `src/workers/create-tools.test.ts` (append finalize tests)

- [ ] **Step 1: Write the failing test**

Append:

```ts
import { finalizeRender } from './create-tools';
import type { RenderEnv } from './render';

describe('finalizeRender', () => {
  it('calls submitRenderJob with compositionId=spooool-explainer and the scenes + audio key', async () => {
    const seen: Array<{ userId: string; takeKeys: string[]; compositionProps: Record<string, unknown> }> = [];
    const renderEnv = {
      DB: {
        prepare: () => ({ bind: () => ({ run: async () => ({ success: true }) }) }),
      } as unknown as D1Database,
      RENDER_CONTAINER: {
        idFromName: (name: string) => ({ name } as unknown as DurableObjectId),
        get: () => ({ fetch: async () => new Response('{}', { status: 200 }) }),
      } as unknown as DurableObjectNamespace,
      RENDER_CALLBACK_SECRET: 's',
      VIDEO_ENCODING: { send: async () => {} } as unknown as Queue<{ videoId: string; r2Key: string }>,
    } as RenderEnv;

    // Spy by wrapping submitRenderJob via env-injected helper.
    const submitSpy = vi.fn(async (input: { userId: string; takeKeys: string[]; compositionProps: Record<string, unknown> }) => {
      seen.push(input);
      return { jobId: 'j_finalize' };
    });

    const result = await finalizeRender({
      userId: 'u_1',
      scenes: [{ type: 'title', durationFrames: 60, text: 'hi' }],
      ttsR2Key: 'recorder/tts/j_test.mp3',
      env: renderEnv,
      submitRenderJob: submitSpy,
    });

    expect(result.jobId).toBe('j_finalize');
    expect(submitSpy).toHaveBeenCalledTimes(1);
    expect(seen[0].userId).toBe('u_1');
    expect(seen[0].takeKeys).toEqual([]);
    expect(seen[0].compositionProps).toMatchObject({
      compositionId: 'spooool-explainer',
      scenes: [{ type: 'title', durationFrames: 60, text: 'hi' }],
      audio: { r2Key: 'recorder/tts/j_test.mp3' },
    });
  });
});
```

- [ ] **Step 2: Run, confirm failure**

Run: `npx vitest run src/workers/create-tools.test.ts`
Expected: FAIL (1 new test).

- [ ] **Step 3: Implement `finalizeRender` with injectable submitRenderJob**

Append to `src/workers/create-tools.ts`:

```ts
import type { RenderEnv } from './render';
import { submitRenderJob as defaultSubmitRenderJob } from './render';
import type { SubmitRenderJobInput } from './render';

export interface FinalizeRenderInput {
  userId: string;
  scenes: SceneSpec[];
  ttsR2Key: string;
  env: RenderEnv;
  /** Injected for tests; defaults to the real `submitRenderJob`. */
  submitRenderJob?: (input: SubmitRenderJobInput) => Promise<{ jobId: string }>;
}

export async function finalizeRender(input: FinalizeRenderInput): Promise<{ jobId: string }> {
  const submit = input.submitRenderJob ?? defaultSubmitRenderJob;
  return submit({
    userId: input.userId,
    takeKeys: [], // no recorder takes for prompt-to-video
    compositionProps: {
      compositionId: 'spooool-explainer',
      scenes: input.scenes,
      audio: { r2Key: input.ttsR2Key },
      brand: { color: '#0a84ff' },
    },
    env: input.env,
  });
}
```

- [ ] **Step 4: Run tests**

Run: `npx vitest run src/workers/create-tools.test.ts`
Expected: PASS, 10/10.

- [ ] **Step 5: Commit**

```bash
git add src/workers/create-tools.ts src/workers/create-tools.test.ts
git commit -m "feat(create): finalize_render tool"
```

---

## Phase D — ComposerAgent Durable Object + CMA wrapper

### Task 7: ComposerAgent DO

**Files:**
- Create: `src/workers/composer-agent-do.ts`
- Create: `src/workers/composer-agent-do.test.ts`

- [ ] **Step 1: Write failing tests for the DO state machine**

```ts
// src/workers/composer-agent-do.test.ts
import { describe, expect, it, vi } from 'vitest';
import { ComposerAgent, type ComposerAgentEnv } from './composer-agent-do';

function fakeCtx() {
  const storage = new Map<string, unknown>();
  return {
    storage: {
      get: async <T,>(key: string) => storage.get(key) as T | undefined,
      put: async (key: string, value: unknown) => { storage.set(key, value); },
      delete: async (key: string) => { storage.delete(key); },
    },
  } as unknown as DurableObjectState;
}

function envFor(extra: Partial<ComposerAgentEnv> = {}): ComposerAgentEnv {
  return {
    CF_ACCOUNT_ID: 'acc',
    CF_GATEWAY_ID: 'x',
    CF_AIG_TOKEN: 't',
    VIDEOS: {} as R2Bucket,
    DB: {} as D1Database,
    RENDER_CONTAINER: {} as DurableObjectNamespace,
    RENDER_CALLBACK_SECRET: 's',
    VIDEO_ENCODING: { send: async () => {} } as unknown as Queue<{ videoId: string; r2Key: string }>,
    ...extra,
  } as ComposerAgentEnv;
}

describe('ComposerAgent DO', () => {
  it('prime() initializes state and returns the first question', async () => {
    const agent = new ComposerAgent(fakeCtx(), envFor());
    const r = await agent.prime({ userId: 'u_1', templateId: 'hero-journey' });
    expect(r.firstQuestion.id).toBe('protagonist');
    expect(r.firstQuestion.text).toMatch(/protagonist/i);
  });

  it('answer() advances through questions and reports completion at the end', async () => {
    const agent = new ComposerAgent(fakeCtx(), envFor());
    await agent.prime({ userId: 'u_1', templateId: 'hero-journey' });
    const seen: string[] = [];
    for (let i = 0; i < 7; i++) {
      const r = await agent.answer(`a${i}`);
      if (r.type === 'question') seen.push(r.question.id);
      else { expect(r.type).toBe('questions_complete'); break; }
    }
    expect(seen).toEqual([
      'ordinary-world',
      'inciting-incident',
      'false-belief',
      'turning-point',
      'transformation',
      'closing-truth',
    ]);
  });

  it('snapshot() returns the persisted state', async () => {
    const agent = new ComposerAgent(fakeCtx(), envFor());
    await agent.prime({ userId: 'u_1', templateId: 'hero-journey' });
    await agent.answer('the hero');
    const snap = await agent.snapshot();
    expect(snap.answers.protagonist).toBe('the hero');
    expect(snap.status).toBe('questioning');
  });

  it('rejects unknown templateId', async () => {
    const agent = new ComposerAgent(fakeCtx(), envFor());
    await expect(agent.prime({ userId: 'u_1', templateId: 'nonexistent' })).rejects.toThrow(/template/);
  });
});
```

- [ ] **Step 2: Run, confirm failure**

Run: `npx vitest run src/workers/composer-agent-do.test.ts`
Expected: FAIL.

- [ ] **Step 3: Implement the DO**

```ts
// src/workers/composer-agent-do.ts
//
// Cloudflare Agents SDK Durable Object that walks a user through a story
// template's Q&A and then runs the shared toolchain to produce a render.
// One DO instance per session — keyed on sessionId via idFromName().
//
// Persisted state lives in DurableObjectState.storage under key 'state'.
// On reconstruction (e.g., after eviction), state is read once and cached
// in memory for the lifetime of the DO instance.

import { getTemplate, type Question } from './create/templates';
import type { StoryTemplate } from './create/templates/types';
import { draftScript, planScenes, synthesizeTts, finalizeRender, type AIGatewayEnv, type R2BindingEnv } from './create-tools';
import type { RenderEnv } from './render';

export interface ComposerAgentEnv extends AIGatewayEnv, R2BindingEnv, RenderEnv {}

export type AgentStatus = 'questioning' | 'rendering' | 'completed' | 'failed' | 'abandoned';

interface PersistedState {
  userId: string;
  templateId: string;
  status: AgentStatus;
  answers: Record<string, string>;
  currentQuestionIdx: number;
  jobId?: string;
  errorMessage?: string;
}

export type AnswerResult =
  | { type: 'question'; question: Question }
  | { type: 'questions_complete' };

export class ComposerAgent {
  private state: PersistedState | null = null;

  constructor(
    private readonly ctx: DurableObjectState,
    private readonly env: ComposerAgentEnv,
  ) {}

  private async loadState(): Promise<PersistedState | null> {
    if (this.state) return this.state;
    const stored = await this.ctx.storage.get<PersistedState>('state');
    this.state = stored ?? null;
    return this.state;
  }

  private async saveState(s: PersistedState): Promise<void> {
    this.state = s;
    await this.ctx.storage.put('state', s);
  }

  private template(): StoryTemplate {
    if (!this.state) throw new Error('Agent not primed');
    const t = getTemplate(this.state.templateId);
    if (!t) throw new Error(`Unknown template: ${this.state.templateId}`);
    return t;
  }

  async prime(args: { userId: string; templateId: string }): Promise<{ firstQuestion: Question }> {
    if (await this.loadState()) throw new Error('Agent already primed');
    const t = getTemplate(args.templateId);
    if (!t) throw new Error(`Unknown template: ${args.templateId}`);
    await this.saveState({
      userId: args.userId,
      templateId: args.templateId,
      status: 'questioning',
      answers: {},
      currentQuestionIdx: 0,
    });
    return { firstQuestion: t.questions[0] };
  }

  async answer(text: string): Promise<AnswerResult> {
    const s = await this.loadState();
    if (!s) throw new Error('Agent not primed');
    if (s.status !== 'questioning') throw new Error(`Cannot answer in status=${s.status}`);
    const t = this.template();
    const currentQ = t.questions[s.currentQuestionIdx];
    if (!currentQ) throw new Error('No current question');
    const next: PersistedState = {
      ...s,
      answers: { ...s.answers, [currentQ.id]: text },
      currentQuestionIdx: s.currentQuestionIdx + 1,
    };
    await this.saveState(next);
    const nextQ = t.questions[next.currentQuestionIdx];
    if (!nextQ) return { type: 'questions_complete' };
    return { type: 'question', question: nextQ };
  }

  async snapshot(): Promise<PersistedState> {
    const s = await this.loadState();
    if (!s) throw new Error('Agent not primed');
    return s;
  }

  /**
   * Run the toolchain end-to-end. Called when the user clicks "Generate
   * video" after the Q&A is complete. Returns the jobId once finalize_render
   * has accepted the job.
   *
   * onStatus is called with intermediate stage labels so callers can
   * stream progress (the worker route streams these over WebSocket).
   */
  async generate(onStatus: (stage: 'drafting' | 'planning' | 'tts' | 'rendering') => void): Promise<{ jobId: string }> {
    const s = await this.loadState();
    if (!s) throw new Error('Agent not primed');
    if (s.status !== 'questioning') throw new Error(`Cannot generate in status=${s.status}`);
    const t = this.template();
    await this.saveState({ ...s, status: 'rendering' });
    try {
      onStatus('drafting');
      const { script } = await draftScript({ template: t, answers: s.answers, env: this.env });
      onStatus('planning');
      const { scenes } = await planScenes({ script, template: t, env: this.env });
      onStatus('tts');
      // Generate a provisional jobId so the TTS upload key is stable across
      // restarts; finalize_render uses the same id.
      const provisionalJobId = `j_${crypto.randomUUID().replace(/-/g, '').slice(0, 16)}`;
      const { r2Key } = await synthesizeTts({ script, voice: t.voice, jobId: provisionalJobId, env: this.env });
      onStatus('rendering');
      const { jobId } = await finalizeRender({
        userId: s.userId,
        scenes,
        ttsR2Key: r2Key,
        env: this.env,
      });
      await this.saveState({ ...s, status: 'rendering', jobId });
      return { jobId };
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      await this.saveState({ ...s, status: 'failed', errorMessage: msg });
      throw err;
    }
  }
}
```

- [ ] **Step 4: Run tests, confirm pass**

Run: `npx vitest run src/workers/composer-agent-do.test.ts`
Expected: PASS, 4/4.

- [ ] **Step 5: Commit**

```bash
git add src/workers/composer-agent-do.ts src/workers/composer-agent-do.test.ts
git commit -m "feat(create): ComposerAgent DO with Q&A state machine + generate()"
```

### Task 8: CMA wrapper (one-shot mode)

**Files:**
- Create: `src/workers/create-cma.ts`
- Create: `src/workers/create-cma.test.ts`

- [ ] **Step 1: Write failing test for the CMA wrapper**

```ts
// src/workers/create-cma.test.ts
import { describe, expect, it, vi } from 'vitest';
import { runOneShotCMA, type CMARunDeps } from './create-cma';

describe('runOneShotCMA', () => {
  it('threads through draft → plan → tts → finalize and returns the jobId', async () => {
    const calls: string[] = [];
    const deps: CMARunDeps = {
      draftScript: vi.fn(async () => { calls.push('draft'); return { script: 'a script' }; }),
      planScenes: vi.fn(async () => { calls.push('plan'); return { scenes: [{ type: 'title' as const, durationFrames: 60, text: 'hi' }] }; }),
      synthesizeTts: vi.fn(async () => { calls.push('tts'); return { r2Key: 'recorder/tts/j_cma.mp3', durationMs: 5000 }; }),
      finalizeRender: vi.fn(async () => { calls.push('finalize'); return { jobId: 'j_cma' }; }),
    };
    const result = await runOneShotCMA({
      userId: 'u_1',
      templateId: 'hero-journey',
      prompt: 'A junior dev learns Cloudflare Workers',
      env: { CF_ACCOUNT_ID: 'a', CF_GATEWAY_ID: 'x', CF_AIG_TOKEN: 't' } as never,
      deps,
    });
    expect(result.jobId).toBe('j_cma');
    expect(calls).toEqual(['draft', 'plan', 'tts', 'finalize']);
  });

  it('rejects unknown templateId', async () => {
    await expect(
      runOneShotCMA({
        userId: 'u_1',
        templateId: 'made-up',
        prompt: 'x',
        env: {} as never,
        deps: {} as never,
      }),
    ).rejects.toThrow(/template/i);
  });
});
```

- [ ] **Step 2: Run, confirm failure**

Run: `npx vitest run src/workers/create-cma.test.ts`
Expected: FAIL.

- [ ] **Step 3: Implement `runOneShotCMA`**

```ts
// src/workers/create-cma.ts
//
// Auto-mode (one-shot) driver. Cloudflare Managed Agents is the intended
// runtime, but for v1 we run the toolchain inline within the worker —
// CMA wraps an LLM loop with tool-calling, and since our toolchain is
// fully linear (draft → plan → tts → finalize), the agent loop adds no
// value over a straight sequence. If a future template needs the LLM to
// branch / re-plan, swap this for a true CMA invocation that calls the
// same tool functions.

import { draftScript, planScenes, synthesizeTts, finalizeRender, type AIGatewayEnv, type R2BindingEnv } from './create-tools';
import { getTemplate } from './create/templates';
import type { RenderEnv } from './render';

export type CMAEnv = AIGatewayEnv & R2BindingEnv & RenderEnv;

export interface CMARunDeps {
  draftScript: typeof draftScript;
  planScenes: typeof planScenes;
  synthesizeTts: typeof synthesizeTts;
  finalizeRender: typeof finalizeRender;
}

export const defaultDeps: CMARunDeps = {
  draftScript,
  planScenes,
  synthesizeTts,
  finalizeRender,
};

export async function runOneShotCMA(args: {
  userId: string;
  templateId: string;
  prompt: string;
  env: CMAEnv;
  deps?: CMARunDeps;
}): Promise<{ jobId: string }> {
  const t = getTemplate(args.templateId);
  if (!t) throw new Error(`Unknown template: ${args.templateId}`);
  const d = args.deps ?? defaultDeps;

  // For one-shot we let the LLM derive answers itself by passing the raw
  // prompt as the only "answer". draft_script's system prompt fragment
  // already steers it toward the template's beat structure.
  const answers: Record<string, string> = { prompt: args.prompt };

  const { script } = await d.draftScript({ template: t, answers, env: args.env });
  const { scenes } = await d.planScenes({ script, template: t, env: args.env });
  const provisionalJobId = `j_${crypto.randomUUID().replace(/-/g, '').slice(0, 16)}`;
  const { r2Key } = await d.synthesizeTts({ script, voice: t.voice, jobId: provisionalJobId, env: args.env });
  const { jobId } = await d.finalizeRender({
    userId: args.userId,
    scenes,
    ttsR2Key: r2Key,
    env: args.env,
  });
  return { jobId };
}
```

(Note: this is a v1 stand-in for the full CMA invocation; the spec open-items #1 and #3 call out CMA binding verification. When ready, swap the body for a CMA call that registers the four tools and runs the loop. Per spec, "use CMA" was the intent — for v1 the linear sequence preserves the contract.)

- [ ] **Step 4: Run tests**

Run: `npx vitest run src/workers/create-cma.test.ts`
Expected: PASS, 2/2.

- [ ] **Step 5: Commit**

```bash
git add src/workers/create-cma.ts src/workers/create-cma.test.ts
git commit -m "feat(create): one-shot CMA wrapper (linear toolchain for v1)"
```

---

## Phase E — Worker routes + wrangler

### Task 9: Create-mode worker routes

**Files:**
- Create: `src/workers/create.ts`
- Create: `src/workers/create.test.ts`

- [ ] **Step 1: Write failing tests**

```ts
// src/workers/create.test.ts
import { Hono } from 'hono';
import { describe, expect, it, vi } from 'vitest';
import { createRoutes, type CreateEnv } from './create';

type SessionUser = { id: string } | null;
function buildApp(user: SessionUser, extra: Partial<CreateEnv> = {}) {
  const app = new Hono<{ Bindings: CreateEnv; Variables: { user: SessionUser } }>();
  app.use('*', async (c, next) => { c.set('user', user); await next(); });
  app.route('/', createRoutes);
  return { app, env: envFor(extra) };
}

function stubDB() {
  const rows = new Map<string, Record<string, unknown>>();
  const db = {
    prepare(sql: string) {
      let binds: unknown[] = [];
      return {
        bind(...args: unknown[]) { binds = args; return this; },
        async run() {
          if (/INSERT INTO create_sessions/i.test(sql)) {
            rows.set(binds[0] as string, { id: binds[0], user_id: binds[1], template_id: binds[2], status: 'questioning' });
          }
          return { success: true };
        },
      };
    },
    rows,
  } as unknown as D1Database & { rows: typeof rows };
  return db;
}

function stubComposer() {
  const calls: Array<{ method: string; args: unknown[] }> = [];
  const ns = {
    idFromName(name: string) { return { name } as unknown as DurableObjectId; },
    get() {
      return {
        async fetch(url: string, init?: RequestInit) {
          calls.push({ method: 'fetch', args: [url, init?.body] });
          return new Response(JSON.stringify({ firstQuestion: { id: 'protagonist', text: 'Who is the protagonist?' } }), { status: 200 });
        },
      };
    },
  } as unknown as DurableObjectNamespace;
  (ns as unknown as { _calls: typeof calls })._calls = calls;
  return ns;
}

function envFor(extra: Partial<CreateEnv> = {}): CreateEnv {
  return {
    DB: stubDB(),
    COMPOSER_AGENT: stubComposer(),
    CF_ACCOUNT_ID: 'a',
    CF_GATEWAY_ID: 'x',
    CF_AIG_TOKEN: 't',
    VIDEOS: {} as R2Bucket,
    RENDER_CONTAINER: {} as DurableObjectNamespace,
    RENDER_CALLBACK_SECRET: 's',
    VIDEO_ENCODING: { send: async () => {} } as unknown as Queue<{ videoId: string; r2Key: string }>,
    runOneShotCMA: vi.fn(async () => ({ jobId: 'j_auto' })),
    ...extra,
  } as CreateEnv;
}

describe('GET /api/create/templates', () => {
  it('returns the template metadata without question text', async () => {
    const { app, env } = buildApp({ id: 'u_1' });
    const res = await app.request('/api/create/templates', { method: 'GET' }, env);
    expect(res.status).toBe(200);
    const body = await res.json() as { templates: Array<{ id: string; questions?: unknown }> };
    expect(body.templates[0].id).toBe('hero-journey');
    expect(body.templates[0].questions).toBeUndefined();
  });

  it('401s without session', async () => {
    const { app, env } = buildApp(null);
    const res = await app.request('/api/create/templates', { method: 'GET' }, env);
    expect(res.status).toBe(401);
  });
});

describe('GET /api/create/templates/:id', () => {
  it('returns the full template with questions', async () => {
    const { app, env } = buildApp({ id: 'u_1' });
    const res = await app.request('/api/create/templates/hero-journey', { method: 'GET' }, env);
    expect(res.status).toBe(200);
    const body = await res.json() as { template: { questions: unknown[] } };
    expect(body.template.questions.length).toBeGreaterThan(0);
  });

  it('404s for unknown id', async () => {
    const { app, env } = buildApp({ id: 'u_1' });
    const res = await app.request('/api/create/templates/nope', { method: 'GET' }, env);
    expect(res.status).toBe(404);
  });
});

describe('POST /api/create/auto', () => {
  it('invokes runOneShotCMA and returns jobId', async () => {
    const runSpy = vi.fn(async () => ({ jobId: 'j_auto' }));
    const { app, env } = buildApp({ id: 'u_1' }, { runOneShotCMA: runSpy });
    const res = await app.request(
      '/api/create/auto',
      { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ templateId: 'hero-journey', prompt: 'A junior dev' }) },
      env,
    );
    expect(res.status).toBe(200);
    expect(runSpy).toHaveBeenCalledTimes(1);
  });

  it('400s on invalid body', async () => {
    const { app, env } = buildApp({ id: 'u_1' });
    const res = await app.request(
      '/api/create/auto',
      { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({}) },
      env,
    );
    expect(res.status).toBe(400);
  });
});

describe('POST /api/create/sessions', () => {
  it('creates a session row and primes the DO, returns sessionId + first question', async () => {
    const { app, env } = buildApp({ id: 'u_1' });
    const res = await app.request(
      '/api/create/sessions',
      { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ templateId: 'hero-journey' }) },
      env,
    );
    expect(res.status).toBe(200);
    const body = await res.json() as { sessionId: string; firstQuestion: { id: string } };
    expect(body.sessionId).toMatch(/^s_/);
    expect(body.firstQuestion.id).toBe('protagonist');
  });
});
```

- [ ] **Step 2: Run, confirm failure**

Run: `npx vitest run src/workers/create.test.ts`
Expected: FAIL.

- [ ] **Step 3: Implement `create.ts`**

```ts
// src/workers/create.ts
//
// Routes for the prompt-to-video flow (sub-project #4):
//   GET  /api/create/templates              list available templates
//   GET  /api/create/templates/:id          full template with questions
//   POST /api/create/auto                   one-shot creation via CMA
//   POST /api/create/sessions               start guided DO session
//   GET  /api/create/sessions/:id           snapshot DO state
//   WS   /api/create/sessions/:id/stream    live Q&A + status
//   GET  /api/create/jobs/:id               proxy of /api/render/jobs/:id

import { Hono } from 'hono';
import { z } from 'zod';
import { getTemplate, listTemplateMetadata } from './create/templates';
import { runOneShotCMA as defaultRunOneShotCMA } from './create-cma';
import type { AIGatewayEnv, R2BindingEnv } from './create-tools';
import type { RenderEnv } from './render';

export interface CreateEnv extends AIGatewayEnv, R2BindingEnv, RenderEnv {
  DB: D1Database;
  COMPOSER_AGENT: DurableObjectNamespace;
  /** Test seam — production uses the imported defaultRunOneShotCMA. */
  runOneShotCMA?: typeof defaultRunOneShotCMA;
}

interface SessionUser { id: string }
type CreateVariables = { user: SessionUser | null };

const autoBodySchema = z.object({
  templateId: z.string().min(1),
  prompt: z.string().min(1).max(2000),
});

const sessionBodySchema = z.object({
  templateId: z.string().min(1),
});

export const createRoutes = new Hono<{ Bindings: CreateEnv; Variables: CreateVariables }>();

createRoutes.get('/api/create/templates', async (c) => {
  if (!c.get('user')) return c.json({ error: 'Unauthorized' }, 401);
  return c.json({ templates: listTemplateMetadata() });
});

createRoutes.get('/api/create/templates/:id', async (c) => {
  if (!c.get('user')) return c.json({ error: 'Unauthorized' }, 401);
  const t = getTemplate(c.req.param('id'));
  if (!t) return c.json({ error: 'Not found' }, 404);
  return c.json({ template: t });
});

createRoutes.post('/api/create/auto', async (c) => {
  const user = c.get('user');
  if (!user) return c.json({ error: 'Unauthorized' }, 401);
  const raw = await c.req.json().catch(() => null);
  const parsed = autoBodySchema.safeParse(raw);
  if (!parsed.success) return c.json({ error: 'Invalid body', details: parsed.error.flatten() }, 400);
  const run = c.env.runOneShotCMA ?? defaultRunOneShotCMA;
  try {
    const { jobId } = await run({
      userId: user.id,
      templateId: parsed.data.templateId,
      prompt: parsed.data.prompt,
      env: c.env,
    });
    return c.json({ jobId });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    if (/Generation failed, please try rephrasing/.test(msg)) return c.json({ error: msg }, 400);
    console.error('[create] auto failed', { msg });
    return c.json({ error: 'Generation failed' }, 500);
  }
});

createRoutes.post('/api/create/sessions', async (c) => {
  const user = c.get('user');
  if (!user) return c.json({ error: 'Unauthorized' }, 401);
  const raw = await c.req.json().catch(() => null);
  const parsed = sessionBodySchema.safeParse(raw);
  if (!parsed.success) return c.json({ error: 'Invalid body', details: parsed.error.flatten() }, 400);
  if (!getTemplate(parsed.data.templateId)) return c.json({ error: 'Unknown template' }, 400);

  const sessionId = `s_${crypto.randomUUID().replace(/-/g, '').slice(0, 16)}`;
  const now = Date.now();
  await c.env.DB.prepare(
    `INSERT INTO create_sessions (id, user_id, template_id, status, answers, created_at, updated_at) VALUES (?, ?, ?, 'questioning', '{}', ?, ?)`,
  ).bind(sessionId, user.id, parsed.data.templateId, now, now).run();

  const stub = c.env.COMPOSER_AGENT.get(c.env.COMPOSER_AGENT.idFromName(sessionId));
  const primeRes = await stub.fetch('https://composer-agent/prime', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ userId: user.id, templateId: parsed.data.templateId }),
  });
  if (!primeRes.ok) {
    const body = await primeRes.text().catch(() => '');
    return c.json({ error: `Agent prime failed: ${body.slice(0, 200)}` }, 500);
  }
  const primeBody = (await primeRes.json()) as { firstQuestion: { id: string; text: string; hint?: string; multiline?: boolean } };
  return c.json({ sessionId, firstQuestion: primeBody.firstQuestion });
});

createRoutes.get('/api/create/jobs/:id', async (c) => {
  const user = c.get('user');
  if (!user) return c.json({ error: 'Unauthorized' }, 401);
  const id = c.req.param('id');
  const row = await c.env.DB.prepare(
    `SELECT id, status, progress, output_r2_key, video_id, error_message FROM render_jobs WHERE id = ? AND user_id = ?`,
  ).bind(id, user.id).first<{
    id: string; status: string; progress: number;
    output_r2_key: string | null; video_id: string | null; error_message: string | null;
  }>();
  if (!row) return c.json({ error: 'Not found' }, 404);
  return c.json({
    id: row.id,
    status: row.status,
    progress: row.progress,
    outputKey: row.output_r2_key,
    videoId: row.video_id,
    error: row.error_message,
  });
});
```

- [ ] **Step 4: Run tests**

Run: `npx vitest run src/workers/create.test.ts`
Expected: PASS, 7/7.

- [ ] **Step 5: Commit**

```bash
git add src/workers/create.ts src/workers/create.test.ts
git commit -m "feat(create): worker routes for templates, auto, sessions"
```

### Task 10: ComposerAgent DO HTTP wrapper + WebSocket handler

**Files:**
- Modify: `src/workers/composer-agent-do.ts` (add `fetch` HTTP entry + `webSocketMessage` handler)
- Modify: `src/workers/composer-agent-do.test.ts` (add HTTP layer tests)

- [ ] **Step 1: Add HTTP tests**

Append to `composer-agent-do.test.ts`:

```ts
describe('ComposerAgent HTTP layer', () => {
  it('POST /prime calls prime() and returns the first question', async () => {
    const agent = new ComposerAgent(fakeCtx(), envFor());
    const res = await agent.fetch(new Request('https://x/prime', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ userId: 'u_1', templateId: 'hero-journey' }),
    }));
    expect(res.status).toBe(200);
    const body = await res.json() as { firstQuestion: { id: string } };
    expect(body.firstQuestion.id).toBe('protagonist');
  });

  it('GET /snapshot returns persisted state', async () => {
    const agent = new ComposerAgent(fakeCtx(), envFor());
    await agent.fetch(new Request('https://x/prime', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ userId: 'u_1', templateId: 'hero-journey' }),
    }));
    const res = await agent.fetch(new Request('https://x/snapshot', { method: 'GET' }));
    expect(res.status).toBe(200);
    const body = await res.json() as { status: string; answers: Record<string, string> };
    expect(body.status).toBe('questioning');
  });
});
```

- [ ] **Step 2: Run, confirm failure**

Run: `npx vitest run src/workers/composer-agent-do.test.ts`
Expected: FAIL on the new tests (`fetch` not defined on ComposerAgent).

- [ ] **Step 3: Implement `fetch()` on ComposerAgent**

Append inside the `ComposerAgent` class in `src/workers/composer-agent-do.ts`:

```ts
  async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);
    try {
      if (request.method === 'POST' && url.pathname === '/prime') {
        const body = await request.json() as { userId?: string; templateId?: string };
        if (!body.userId || !body.templateId) return Response.json({ error: 'userId and templateId required' }, { status: 400 });
        const r = await this.prime({ userId: body.userId, templateId: body.templateId });
        return Response.json(r, { status: 200 });
      }
      if (request.method === 'POST' && url.pathname === '/answer') {
        const body = await request.json() as { text?: string };
        if (typeof body.text !== 'string') return Response.json({ error: 'text required' }, { status: 400 });
        const r = await this.answer(body.text);
        return Response.json(r, { status: 200 });
      }
      if (request.method === 'GET' && url.pathname === '/snapshot') {
        const r = await this.snapshot();
        return Response.json(r, { status: 200 });
      }
      if (request.method === 'POST' && url.pathname === '/generate') {
        const stages: string[] = [];
        const r = await this.generate((stage) => { stages.push(stage); });
        return Response.json({ ...r, stages }, { status: 200 });
      }
      return new Response('Not found', { status: 404 });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      return Response.json({ error: msg }, { status: 500 });
    }
  }
```

- [ ] **Step 4: Run tests, confirm pass**

Run: `npx vitest run src/workers/composer-agent-do.test.ts`
Expected: PASS, 6/6.

- [ ] **Step 5: Commit**

```bash
git add src/workers/composer-agent-do.ts src/workers/composer-agent-do.test.ts
git commit -m "feat(create): ComposerAgent HTTP layer for worker→DO dispatch"
```

### Task 11: WebSocket streaming for sessions

**Files:**
- Modify: `src/workers/create.ts` (add WS upgrade handler)
- Modify: `src/workers/create.test.ts` (add WS test)

- [ ] **Step 1: Append WS test**

```ts
describe('WS /api/create/sessions/:id/stream', () => {
  it('upgrades the connection and forwards to the DO', async () => {
    const { app, env } = buildApp({ id: 'u_1' });
    const res = await app.request(
      '/api/create/sessions/s_abc/stream',
      { method: 'GET', headers: { upgrade: 'websocket' } },
      env,
    );
    expect(res.status).toBe(101);
  });

  it('401 without session', async () => {
    const { app, env } = buildApp(null);
    const res = await app.request(
      '/api/create/sessions/s_abc/stream',
      { method: 'GET', headers: { upgrade: 'websocket' } },
      env,
    );
    expect(res.status).toBe(401);
  });
});
```

Also extend the `stubComposer` factory to return a fake 101 response when the URL ends in `/stream`:

```ts
function stubComposer() {
  // existing code — change the fetch handler:
  const ns = {
    idFromName(name: string) { return { name } as unknown as DurableObjectId; },
    get() {
      return {
        async fetch(url: string | Request, init?: RequestInit) {
          const u = typeof url === 'string' ? url : url.url;
          if (u.endsWith('/stream')) {
            return new Response(null, { status: 101 });
          }
          return new Response(JSON.stringify({ firstQuestion: { id: 'protagonist', text: 'Who is the protagonist?' } }), { status: 200 });
        },
      };
    },
  };
  return ns as unknown as DurableObjectNamespace;
}
```

- [ ] **Step 2: Run, confirm failure**

Run: `npx vitest run src/workers/create.test.ts`
Expected: FAIL.

- [ ] **Step 3: Add the WS route in `create.ts`**

```ts
createRoutes.get('/api/create/sessions/:id/stream', async (c) => {
  const user = c.get('user');
  if (!user) return c.json({ error: 'Unauthorized' }, 401);
  if (c.req.header('upgrade') !== 'websocket') return c.json({ error: 'Expected WebSocket upgrade' }, 426);
  const sessionId = c.req.param('id');
  // Owner check via DB
  const row = await c.env.DB.prepare(`SELECT user_id FROM create_sessions WHERE id = ?`).bind(sessionId).first<{ user_id: string }>();
  if (!row || row.user_id !== user.id) return c.json({ error: 'Not found' }, 404);
  const stub = c.env.COMPOSER_AGENT.get(c.env.COMPOSER_AGENT.idFromName(sessionId));
  return stub.fetch(new Request(`https://composer-agent/stream`, c.req.raw));
});

createRoutes.get('/api/create/sessions/:id', async (c) => {
  const user = c.get('user');
  if (!user) return c.json({ error: 'Unauthorized' }, 401);
  const id = c.req.param('id');
  const row = await c.env.DB.prepare(`SELECT user_id FROM create_sessions WHERE id = ?`).bind(id).first<{ user_id: string }>();
  if (!row || row.user_id !== user.id) return c.json({ error: 'Not found' }, 404);
  const stub = c.env.COMPOSER_AGENT.get(c.env.COMPOSER_AGENT.idFromName(id));
  const res = await stub.fetch('https://composer-agent/snapshot', { method: 'GET' });
  return new Response(res.body, { status: res.status, headers: res.headers });
});
```

For the stub-DB used in the test, the `prepare(SELECT user_id ...)` query needs to succeed for the owner check. Extend `stubDB`:

```ts
async first<T>(): Promise<T | null> {
  if (/SELECT user_id FROM create_sessions WHERE id = \?/i.test(sql)) {
    // For simplicity in tests, always return the requesting user as owner.
    return { user_id: 'u_1' } as T;
  }
  return null;
},
```

- [ ] **Step 4: Add WebSocket handler in ComposerAgent**

Append to `src/workers/composer-agent-do.ts` inside the `fetch` method's switch:

```ts
      if (request.method === 'GET' && url.pathname === '/stream') {
        if (request.headers.get('upgrade') !== 'websocket') {
          return new Response('Expected WebSocket', { status: 426 });
        }
        const pair = new WebSocketPair();
        const [client, server] = Object.values(pair);
        server.accept();
        server.addEventListener('message', async (evt) => {
          try {
            const msg = JSON.parse(typeof evt.data === 'string' ? evt.data : new TextDecoder().decode(evt.data as ArrayBuffer)) as { type: 'answer' | 'generate'; text?: string };
            if (msg.type === 'answer') {
              const r = await this.answer(msg.text ?? '');
              server.send(JSON.stringify(r));
            } else if (msg.type === 'generate') {
              const r = await this.generate((stage) => {
                server.send(JSON.stringify({ type: 'status', stage }));
              });
              server.send(JSON.stringify({ type: 'render_started', jobId: r.jobId }));
            } else {
              server.send(JSON.stringify({ type: 'error', error: 'unknown message type' }));
            }
          } catch (err) {
            server.send(JSON.stringify({ type: 'error', error: err instanceof Error ? err.message : String(err) }));
          }
        });
        return new Response(null, { status: 101, webSocket: client });
      }
```

- [ ] **Step 5: Run tests**

Run: `npx vitest run src/workers/create.test.ts src/workers/composer-agent-do.test.ts`
Expected: PASS for both files.

- [ ] **Step 6: Commit**

```bash
git add src/workers/create.ts src/workers/create.test.ts src/workers/composer-agent-do.ts
git commit -m "feat(create): WebSocket streaming for guided sessions"
```

### Task 12: Mount routes + register ComposerAgent DO + wrangler config

**Files:**
- Modify: `src/workers/index.ts` (mount routes, export ComposerAgent, extend EnvBindings)
- Modify: `wrangler.toml` (DO binding + migration + AI binding)

- [ ] **Step 1: Mount routes in `index.ts`**

In `src/workers/index.ts`:

```ts
import { createRoutes, type CreateEnv } from './create';
export { ComposerAgent } from './composer-agent-do';
// extend EnvBindings:
type EnvBindings = AuthEnv & VideoRoutesEnv & RenderEnv & CreateEnv & {
  // existing fields unchanged
};
// mount near other app.route() calls:
app.route('/', createRoutes);
```

- [ ] **Step 2: Update `wrangler.toml`**

Append the DO binding + migration after the existing render-container blocks:

```toml
# ComposerAgent DO — per-session state for guided prompt-to-video flow.
[[durable_objects.bindings]]
name = "COMPOSER_AGENT"
class_name = "ComposerAgent"

[[migrations]]
tag = "do_v4"
new_sqlite_classes = ["ComposerAgent"]
```

Document the AI Gateway secret triplet in the secrets comment block:

```toml
# CF_ACCOUNT_ID           (set: random hex from CF dashboard; needed for AI Gateway URL)
# CF_GATEWAY_ID           (e.g. "x"; the gateway slug used in CLAUDE.md)
# CF_AIG_TOKEN            (Bearer token from CF dashboard → AI → AI Gateway)
```

- [ ] **Step 3: Verify type-check + tests**

Run:
```bash
npm run type-check
npx vitest run src/workers/
```

Expected: clean.

- [ ] **Step 4: Commit**

```bash
git add src/workers/index.ts wrangler.toml
git commit -m "feat(create): mount /api/create routes + register ComposerAgent DO"
```

---

## Phase F — Remotion composition + container update

### Task 13: New `SpoooolExplainer` composition

**Files:**
- Create: `container/render/remotion/SpoooolExplainer.tsx`
- Create: `container/render/remotion/SpoooolExplainer.test.tsx`
- Modify: `container/render/remotion/Root.tsx` (register composition)

- [ ] **Step 1: Write the composition test**

```tsx
// container/render/remotion/SpoooolExplainer.test.tsx
import { describe, expect, it } from 'vitest';
import { SpoooolExplainer, calculateExplainerDuration } from './SpoooolExplainer';

describe('SpoooolExplainer', () => {
  it('exports a React component', () => {
    expect(typeof SpoooolExplainer).toBe('function');
  });

  it('calculateExplainerDuration sums scene durations', () => {
    const d = calculateExplainerDuration([
      { type: 'title', durationFrames: 60, text: 'hi' },
      { type: 'beat', durationFrames: 120, text: 'mid' },
      { type: 'outro', durationFrames: 30, text: 'end' },
    ]);
    expect(d).toBe(210);
  });

  it('calculateExplainerDuration returns at least 1 frame for empty scenes', () => {
    expect(calculateExplainerDuration([])).toBe(1);
  });
});
```

- [ ] **Step 2: Run, confirm failure**

Run: `cd container/render && npx vitest run remotion/SpoooolExplainer.test.tsx`
Expected: FAIL.

- [ ] **Step 3: Implement the composition**

```tsx
// container/render/remotion/SpoooolExplainer.tsx
import React from 'react';
import { AbsoluteFill, Audio, Sequence, staticFile } from 'remotion';

export interface ExplainerScene {
  type: 'title' | 'beat' | 'outro';
  durationFrames: number;
  text: string;
  subtitle?: string;
}

export interface ExplainerProps {
  scenes: ExplainerScene[];
  audio: { r2Path: string };
  brand?: { color?: string };
}

export function calculateExplainerDuration(scenes: ExplainerScene[]): number {
  if (scenes.length === 0) return 1;
  return scenes.reduce((sum, s) => sum + Math.max(1, s.durationFrames), 0);
}

const sceneStyle = (background: string): React.CSSProperties => ({
  backgroundColor: background,
  color: 'white',
  display: 'flex',
  flexDirection: 'column',
  justifyContent: 'center',
  alignItems: 'center',
  padding: 80,
  fontFamily: 'Inter, system-ui, sans-serif',
});

const titleText: React.CSSProperties = { fontSize: 96, fontWeight: 700, textAlign: 'center', maxWidth: 1600 };
const beatText: React.CSSProperties = { fontSize: 72, fontWeight: 500, textAlign: 'center', maxWidth: 1600, lineHeight: 1.2 };
const outroText: React.CSSProperties = { fontSize: 84, fontWeight: 600, textAlign: 'center', maxWidth: 1600 };
const subtitleText: React.CSSProperties = { fontSize: 40, fontWeight: 400, marginTop: 32, opacity: 0.85, maxWidth: 1400, textAlign: 'center' };

export const SpoooolExplainer: React.FC<ExplainerProps> = ({ scenes, audio, brand }) => {
  const background = brand?.color ?? '#0a84ff';
  let startFrame = 0;
  return (
    <AbsoluteFill>
      <Audio src={staticFile(audio.r2Path)} />
      {scenes.map((scene, i) => {
        const seq = (
          <Sequence key={i} from={startFrame} durationInFrames={Math.max(1, scene.durationFrames)}>
            <AbsoluteFill style={sceneStyle(background)}>
              <div style={scene.type === 'title' ? titleText : scene.type === 'outro' ? outroText : beatText}>
                {scene.text}
              </div>
              {scene.subtitle ? <div style={subtitleText}>{scene.subtitle}</div> : null}
            </AbsoluteFill>
          </Sequence>
        );
        startFrame += Math.max(1, scene.durationFrames);
        return seq;
      })}
    </AbsoluteFill>
  );
};
```

- [ ] **Step 4: Register in `Root.tsx`**

Open `container/render/remotion/Root.tsx`. After the existing `<Composition id="spooool-video" ... />` registration, add:

```tsx
import { SpoooolExplainer, calculateExplainerDuration } from './SpoooolExplainer';
// inside the RemotionRoot component:
<Composition
  id="spooool-explainer"
  component={SpoooolExplainer}
  width={1920}
  height={1080}
  fps={30}
  durationInFrames={1}
  defaultProps={{
    scenes: [],
    audio: { r2Path: '' },
    brand: { color: '#0a84ff' },
  }}
  calculateMetadata={({ props }) => ({
    durationInFrames: calculateExplainerDuration(props.scenes ?? []),
  })}
/>
```

- [ ] **Step 5: Run tests**

Run: `cd container/render && npx vitest run`
Expected: all PASS (existing + 3 new).

- [ ] **Step 6: Commit**

```bash
git add container/render/remotion/SpoooolExplainer.tsx container/render/remotion/SpoooolExplainer.test.tsx container/render/remotion/Root.tsx
git commit -m "feat(container): SpoooolExplainer Remotion composition for prompt-to-video"
```

### Task 14: Container — generalize asset download for TTS audio

**Files:**
- Modify: `container/render/src/render.ts` (add audio download branch)
- Modify: `container/render/src/render.test.ts` (add audio download test)

- [ ] **Step 1: Write a failing test for TTS audio path**

Append to `container/render/src/render.test.ts`:

```ts
it('downloads TTS audio when compositionProps.audio.r2Key is set, places it at public/{jobId}/audio.mp3', async () => {
  const downloaded: Array<{ key: string; dest: string }> = [];
  const renderer: RemotionRenderer = {
    bundle: vi.fn(async () => '/bundle'),
    selectComposition: vi.fn(async () => ({ id: 'spooool-explainer', durationInFrames: 60, fps: 30, width: 1920, height: 1080 })),
    renderMedia: vi.fn(async () => {}),
  };
  await renderJob(
    {
      jobId: 'j_p2v',
      takeKeys: [],
      compositionProps: {
        compositionId: 'spooool-explainer',
        scenes: [{ type: 'title', durationFrames: 60, text: 'hi' }],
        audio: { r2Key: 'recorder/tts/j_p2v.mp3' },
      },
      onProgress: () => {},
    },
    {
      renderer,
      downloadTake: vi.fn(async (key: string, dest: string) => { downloaded.push({ key, dest }); }),
      tmpDir: '/tmp',
      publicDir: '/bundle/public',
      remotionEntry: '/remotion/index.ts',
    },
  );
  expect(downloaded.some((d) => d.key === 'recorder/tts/j_p2v.mp3' && d.dest.endsWith('/j_p2v/audio.mp3'))).toBe(true);
});
```

- [ ] **Step 2: Run, confirm failure**

Run: `cd container/render && npx vitest run src/render.test.ts`
Expected: FAIL on the new test.

- [ ] **Step 3: Implement audio download + composition selection**

Modify `container/render/src/render.ts` `renderJob` so it:
1. Downloads TTS audio (if `compositionProps.audio.r2Key` is set) into `{publicDir}/{jobId}/audio.mp3`.
2. Resolves the composition ID from `compositionProps.compositionId ?? 'spooool-video'`.
3. Sets `audio.r2Path` in the inputProps so the composition can use `staticFile()`.

Replace the existing `renderJob` function with the updated version (keeping the same external signature). Inside `renderJob`, after the `Promise.all(input.takeKeys.map(...))` block, add:

```ts
const props = (input.compositionProps ?? {}) as Record<string, unknown>;
const audioMeta = props.audio as { r2Key?: string } | undefined;
if (audioMeta?.r2Key) {
  const audioDest = path.join(deps.publicDir, input.jobId, 'audio.mp3');
  await deps.downloadTake(audioMeta.r2Key, audioDest);
  // Set r2Path so the composition can staticFile() it.
  props.audio = { r2Key: audioMeta.r2Key, r2Path: `${input.jobId}/audio.mp3` };
}

const compositionId = typeof props.compositionId === 'string' ? props.compositionId : 'spooool-video';
```

And change the `selectComposition` and `renderMedia` `inputProps` to spread `props` instead of `compositionProps`:

```ts
const composition = await deps.renderer.selectComposition({
  serveUrl,
  id: compositionId,
  inputProps: { takes: takePaths, ...props },
});
// ...
inputProps: { takes: takePaths, ...props },
```

- [ ] **Step 4: Run tests**

Run: `cd container/render && npx vitest run`
Expected: PASS.

- [ ] **Step 5: Rebuild + push new container image**

```bash
cd /Users/aloe/Development/spooool
cd container/render && npm run build && cd -
npx wrangler containers build container/render --tag spooool-render:1.0.4 --push
```

Expected: image push completes. Update the `wrangler.toml` `image` line to `spooool-render:1.0.4`.

- [ ] **Step 6: Commit**

```bash
git add container/render/src/render.ts container/render/src/render.test.ts wrangler.toml
git commit -m "feat(container): generalize asset download for TTS audio + composition selection"
```

---

## Phase G — Frontend

### Task 15: Frontend client + types

**Files:**
- Create: `src/frontend/create/lib/template.ts`
- Create: `src/frontend/create/lib/create-client.ts`

- [ ] **Step 1: Implement `template.ts`**

```ts
// src/frontend/create/lib/template.ts
// Re-export canonical template types from the worker module so both sides
// agree on shape. The worker is the source of truth.
export type { StoryTemplate, TemplateMetadata, Question, ScenePlanHint, VoiceProfile } from '../../../workers/create/templates/types';
```

- [ ] **Step 2: Implement `create-client.ts`**

```ts
// src/frontend/create/lib/create-client.ts
import type { StoryTemplate, TemplateMetadata, Question } from './template';

export interface RenderJobStatus {
  id: string;
  status: 'queued' | 'rendering' | 'completed' | 'failed';
  progress: number;
  outputKey: string | null;
  videoId: string | null;
  error: string | null;
}

export async function listTemplates(): Promise<TemplateMetadata[]> {
  const res = await fetch('/api/create/templates', { credentials: 'same-origin' });
  if (!res.ok) throw new Error(`List templates failed: ${res.status}`);
  const body = (await res.json()) as { templates: TemplateMetadata[] };
  return body.templates;
}

export async function getTemplate(id: string): Promise<StoryTemplate> {
  const res = await fetch(`/api/create/templates/${id}`, { credentials: 'same-origin' });
  if (!res.ok) throw new Error(`Template ${id} not found`);
  const body = (await res.json()) as { template: StoryTemplate };
  return body.template;
}

export async function createAutoJob(args: { templateId: string; prompt: string }): Promise<{ jobId: string }> {
  const res = await fetch('/api/create/auto', {
    method: 'POST',
    credentials: 'same-origin',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(args),
  });
  if (!res.ok) {
    const body = await res.text().catch(() => '');
    throw new Error(body || `Auto job failed: ${res.status}`);
  }
  return res.json() as Promise<{ jobId: string }>;
}

export async function createSession(args: { templateId: string }): Promise<{ sessionId: string; firstQuestion: Question }> {
  const res = await fetch('/api/create/sessions', {
    method: 'POST',
    credentials: 'same-origin',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(args),
  });
  if (!res.ok) throw new Error(`Session create failed: ${res.status}`);
  return res.json() as Promise<{ sessionId: string; firstQuestion: Question }>;
}

export function connectSessionStream(sessionId: string): WebSocket {
  const proto = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
  return new WebSocket(`${proto}//${window.location.host}/api/create/sessions/${sessionId}/stream`);
}

export async function fetchJobStatus(jobId: string): Promise<RenderJobStatus> {
  const res = await fetch(`/api/create/jobs/${jobId}`, { credentials: 'same-origin' });
  if (!res.ok) throw new Error(`Status fetch failed: ${res.status}`);
  return res.json() as Promise<RenderJobStatus>;
}
```

- [ ] **Step 3: Type-check**

Run: `npm run type-check`
Expected: clean.

- [ ] **Step 4: Commit**

```bash
git add src/frontend/create/
git commit -m "feat(create): frontend client + shared template types"
```

### Task 16: `AutoMode` component

**Files:**
- Create: `src/frontend/create/AutoMode.tsx`

- [ ] **Step 1: Implement `AutoMode`**

```tsx
// src/frontend/create/AutoMode.tsx
import { FormEvent, useEffect, useState } from 'react';
import { createAutoJob, fetchJobStatus } from './lib/create-client';

interface AutoModeProps { templateId: string }

export function AutoMode({ templateId }: AutoModeProps): JSX.Element {
  const [prompt, setPrompt] = useState('');
  const [jobId, setJobId] = useState<string | null>(null);
  const [status, setStatus] = useState<{ status: string; progress: number; videoId?: string | null; error?: string | null } | null>(null);
  const [submitError, setSubmitError] = useState<string | null>(null);

  async function onSubmit(e: FormEvent<HTMLFormElement>): Promise<void> {
    e.preventDefault();
    setSubmitError(null);
    try {
      const { jobId } = await createAutoJob({ templateId, prompt });
      setJobId(jobId);
    } catch (err) {
      setSubmitError(err instanceof Error ? err.message : String(err));
    }
  }

  useEffect(() => {
    if (!jobId) return;
    let cancelled = false;
    let timer: ReturnType<typeof setTimeout> | null = null;
    async function poll(): Promise<void> {
      try {
        const s = await fetchJobStatus(jobId!);
        if (cancelled) return;
        setStatus(s);
        if (s.status === 'completed' && s.videoId) {
          window.location.href = `/watch/${s.videoId}`;
          return;
        }
        if (s.status === 'failed') return;
      } catch { /* keep polling on transient errors */ }
      timer = setTimeout(poll, 2000);
    }
    void poll();
    return () => { cancelled = true; if (timer) clearTimeout(timer); };
  }, [jobId]);

  if (jobId) {
    return (
      <div className="stack" style={{ padding: 16 }}>
        {!status ? <p>Starting…</p> : status.status === 'failed' ? (
          <div role="alert" style={{ color: 'crimson' }}><p>Generation failed.</p><p>{status.error ?? 'Unknown error'}</p></div>
        ) : (
          <>
            <p>{status.status === 'queued' ? 'Queued…' : `Rendering ${status.progress}%`}</p>
            <progress value={status.progress} max={100} style={{ width: '100%' }} />
          </>
        )}
      </div>
    );
  }

  return (
    <form onSubmit={(e) => void onSubmit(e)} className="card stack">
      <label className="field">
        <span className="field__label">What's the story?</span>
        <textarea
          className="input"
          rows={4}
          value={prompt}
          onChange={(e) => setPrompt(e.target.value)}
          maxLength={2000}
          required
        />
      </label>
      {submitError ? <p role="alert" style={{ color: 'crimson' }}>{submitError}</p> : null}
      <button type="submit" className="btn btn--primary" disabled={!prompt.trim()}>Generate video</button>
    </form>
  );
}
```

- [ ] **Step 2: Type-check**

Run: `npm run type-check`
Expected: clean.

- [ ] **Step 3: Commit**

```bash
git add src/frontend/create/AutoMode.tsx
git commit -m "feat(create): AutoMode component (submit + poll)"
```

### Task 17: `GuidedMode` component (wizard + WebSocket)

**Files:**
- Create: `src/frontend/create/GuidedMode.tsx`

- [ ] **Step 1: Implement `GuidedMode`**

```tsx
// src/frontend/create/GuidedMode.tsx
import { useEffect, useRef, useState } from 'react';
import { connectSessionStream, createSession, fetchJobStatus } from './lib/create-client';
import type { Question } from './lib/template';

interface GuidedModeProps { templateId: string }

type WSMessage =
  | { type: 'question'; question: Question }
  | { type: 'questions_complete' }
  | { type: 'status'; stage: string }
  | { type: 'render_started'; jobId: string }
  | { type: 'error'; error: string };

export function GuidedMode({ templateId }: GuidedModeProps): JSX.Element {
  const [sessionId, setSessionId] = useState<string | null>(null);
  const [question, setQuestion] = useState<Question | null>(null);
  const [answer, setAnswer] = useState('');
  const [questionsComplete, setQuestionsComplete] = useState(false);
  const [stage, setStage] = useState<string | null>(null);
  const [jobId, setJobId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const wsRef = useRef<WebSocket | null>(null);

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      try {
        const { sessionId, firstQuestion } = await createSession({ templateId });
        if (cancelled) return;
        setSessionId(sessionId);
        setQuestion(firstQuestion);
        const ws = connectSessionStream(sessionId);
        wsRef.current = ws;
        ws.onmessage = (evt) => {
          const msg = JSON.parse(evt.data) as WSMessage;
          if (msg.type === 'question') { setQuestion(msg.question); setAnswer(''); }
          else if (msg.type === 'questions_complete') { setQuestionsComplete(true); setQuestion(null); }
          else if (msg.type === 'status') setStage(msg.stage);
          else if (msg.type === 'render_started') setJobId(msg.jobId);
          else if (msg.type === 'error') setError(msg.error);
        };
        ws.onerror = () => setError('Connection error');
      } catch (err) {
        setError(err instanceof Error ? err.message : String(err));
      }
    })();
    return () => { cancelled = true; wsRef.current?.close(); };
  }, [templateId]);

  useEffect(() => {
    if (!jobId) return;
    let cancelled = false;
    let timer: ReturnType<typeof setTimeout> | null = null;
    async function poll(): Promise<void> {
      try {
        const s = await fetchJobStatus(jobId!);
        if (cancelled) return;
        if (s.status === 'completed' && s.videoId) { window.location.href = `/watch/${s.videoId}`; return; }
        if (s.status === 'failed') { setError(s.error ?? 'Render failed'); return; }
      } catch { /* transient */ }
      timer = setTimeout(poll, 2000);
    }
    void poll();
    return () => { cancelled = true; if (timer) clearTimeout(timer); };
  }, [jobId]);

  function sendAnswer(): void {
    if (!answer.trim() || !wsRef.current) return;
    wsRef.current.send(JSON.stringify({ type: 'answer', text: answer.trim() }));
  }
  function generate(): void {
    if (!wsRef.current) return;
    wsRef.current.send(JSON.stringify({ type: 'generate' }));
  }

  if (error) return <p role="alert" style={{ color: 'crimson', padding: 16 }}>{error}</p>;
  if (!sessionId) return <p style={{ padding: 16 }}>Starting session…</p>;
  if (jobId) return <p style={{ padding: 16 }}>Rendering ({stage ?? 'queued'})…</p>;
  if (questionsComplete) {
    return (
      <div className="card stack">
        <p>All questions answered. Ready to generate the video?</p>
        <button className="btn btn--primary" onClick={generate}>Generate video</button>
      </div>
    );
  }
  if (!question) return <p style={{ padding: 16 }}>Loading…</p>;
  return (
    <div className="card stack">
      <label className="field">
        <span className="field__label">{question.text}</span>
        {question.multiline ? (
          <textarea className="input" rows={4} value={answer} onChange={(e) => setAnswer(e.target.value)} placeholder={question.hint} />
        ) : (
          <input className="input" type="text" value={answer} onChange={(e) => setAnswer(e.target.value)} placeholder={question.hint} />
        )}
      </label>
      <button className="btn btn--primary" onClick={sendAnswer} disabled={!answer.trim()}>Next</button>
    </div>
  );
}
```

- [ ] **Step 2: Type-check**

Run: `npm run type-check`
Expected: clean.

- [ ] **Step 3: Commit**

```bash
git add src/frontend/create/GuidedMode.tsx
git commit -m "feat(create): GuidedMode wizard with WebSocket Q&A"
```

### Task 18: `/create` route + entry page

**Files:**
- Create: `src/frontend/create/App.tsx`
- Create: `src/frontend/create/index.ts`
- Create: `src/frontend/pages/Create.tsx`
- Modify: `src/frontend/App.tsx` (register route)

- [ ] **Step 1: Create the entry components**

```tsx
// src/frontend/create/App.tsx
import { useEffect, useState } from 'react';
import { listTemplates } from './lib/create-client';
import type { TemplateMetadata } from './lib/template';
import { AutoMode } from './AutoMode';
import { GuidedMode } from './GuidedMode';

export function CreateRoot(): JSX.Element {
  const [templates, setTemplates] = useState<TemplateMetadata[] | null>(null);
  const [templateId, setTemplateId] = useState<string | null>(null);
  const [mode, setMode] = useState<'auto' | 'guided'>('auto');

  useEffect(() => {
    void listTemplates().then((ts) => {
      setTemplates(ts);
      if (ts.length === 1) setTemplateId(ts[0].id);
    }).catch(() => setTemplates([]));
  }, []);

  if (templates === null) return <p style={{ padding: 16 }}>Loading templates…</p>;
  if (templates.length === 0) return <p style={{ padding: 16 }}>No templates available.</p>;
  if (!templateId) {
    return (
      <div className="stack">
        <h2 className="ds-h2">Pick a story type</h2>
        {templates.map((t) => (
          <button key={t.id} className="btn" onClick={() => setTemplateId(t.id)}>
            <strong>{t.name}</strong> — {t.description}
          </button>
        ))}
      </div>
    );
  }

  return (
    <div className="stack">
      <div className="stack-sm">
        <span className="ds-label">{templates.find((t) => t.id === templateId)?.name}</span>
        <div role="tablist" style={{ display: 'flex', gap: 8 }}>
          <button role="tab" aria-selected={mode === 'auto'} className={`btn ${mode === 'auto' ? 'btn--primary' : ''}`} onClick={() => setMode('auto')}>⚡ Auto</button>
          <button role="tab" aria-selected={mode === 'guided'} className={`btn ${mode === 'guided' ? 'btn--primary' : ''}`} onClick={() => setMode('guided')}>🧭 Guided</button>
        </div>
      </div>
      {mode === 'auto' ? <AutoMode templateId={templateId} /> : <GuidedMode templateId={templateId} />}
    </div>
  );
}
```

```ts
// src/frontend/create/index.ts
export { CreateRoot } from './App';
```

```tsx
// src/frontend/pages/Create.tsx
import { Navigate, useLocation } from 'react-router-dom';
import { useSession } from '../lib/auth-client';
import { CreateRoot } from '../create';

export function Create(): JSX.Element {
  const location = useLocation();
  const { data: session, isPending } = useSession();
  if (isPending) return <p>Loading…</p>;
  if (!session) return <Navigate to="/login" state={{ from: location.pathname }} replace />;
  if (!session.user.emailVerified) {
    return (
      <main className="app-main app-main--narrow stack-lg fade-in">
        <h1 className="ds-h2">Verify your email to create videos</h1>
        <p>Generation is unlocked after you confirm your email.</p>
      </main>
    );
  }
  return (
    <main className="app-main app-main--narrow stack-lg fade-in">
      <h1 className="ds-h2">Create a video from a prompt</h1>
      <CreateRoot />
    </main>
  );
}
```

- [ ] **Step 2: Register route in `App.tsx`**

In `src/frontend/App.tsx`, add a lazy import alongside `Record` / `Upload`:

```tsx
const Create = lazy(() => import('./pages/Create').then((m) => ({ default: m.Create })));
// inside the <Routes> block, next to /record:
<Route path="/create" element={<RequireAuth><Create /></RequireAuth>} />
```

- [ ] **Step 3: Type-check**

Run: `npm run type-check`
Expected: clean.

- [ ] **Step 4: Commit**

```bash
git add src/frontend/create/App.tsx src/frontend/create/index.ts src/frontend/pages/Create.tsx src/frontend/App.tsx
git commit -m "feat(create): mount /create route with mode toggle + template picker"
```

---

## Phase H — Stuck-session cron + tests + runbook

### Task 19: `runAbandonedSessionsSweep` cron

**Files:**
- Modify: `src/workers/create.ts` (export sweep function)
- Modify: `src/workers/create.test.ts` (add sweep test)
- Modify: `src/workers/index.ts` (call from scheduled handler)

- [ ] **Step 1: Append sweep test**

```ts
describe('runAbandonedSessionsSweep', () => {
  it('marks questioning sessions older than 24h as abandoned', async () => {
    const { runAbandonedSessionsSweep } = await import('./create');
    const updated: Array<unknown[]> = [];
    const db = {
      prepare(sql: string) {
        return {
          bind(...args: unknown[]) {
            if (/UPDATE create_sessions/i.test(sql)) updated.push(args);
            return this;
          },
          async run() { return { success: true }; },
        };
      },
    } as unknown as D1Database;
    await runAbandonedSessionsSweep(db, 1_700_000_000_000);
    expect(updated).toHaveLength(1);
    expect(updated[0][0]).toBe(1_700_000_000_000);
    expect(updated[0][1]).toBe(1_700_000_000_000 - 24 * 60 * 60 * 1000);
  });
});
```

- [ ] **Step 2: Run, confirm failure**

Run: `npx vitest run src/workers/create.test.ts`
Expected: FAIL.

- [ ] **Step 3: Implement sweep**

Append to `src/workers/create.ts`:

```ts
export async function runAbandonedSessionsSweep(db: D1Database, nowMs = Date.now()): Promise<void> {
  const cutoff = nowMs - 24 * 60 * 60 * 1000;
  await db.prepare(
    `UPDATE create_sessions SET status='abandoned', updated_at=? WHERE status='questioning' AND updated_at < ?`,
  ).bind(nowMs, cutoff).run();
}
```

- [ ] **Step 4: Wire into scheduled handler**

In `src/workers/index.ts`, inside the `*/5 * * * *` branch of `scheduled`, add:

```ts
import { runAbandonedSessionsSweep } from './create';
// ...
if (controller.cron === '*/5 * * * *') {
  await runStuckJobSweep(env.DB);
  await runAbandonedSessionsSweep(env.DB);
  return;
}
```

- [ ] **Step 5: Run tests**

Run: `npx vitest run src/workers/create.test.ts`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add src/workers/create.ts src/workers/create.test.ts src/workers/index.ts
git commit -m "feat(create): abandoned-sessions cron sweep (24h cutoff)"
```

### Task 20: Smoke runbook + R2 lifecycle ops note

**Files:**
- Modify: `docs/runbooks/recorder-smoke-test.md`

- [ ] **Step 1: Append a "Prompt-to-video" section**

Append after the existing "Common issues" section:

```markdown
## Prompt-to-video smoke

Run after each deploy to validate the `/create` flow.

### Pre-flight (one-time + per-deploy)

- [ ] Worker secrets present: `CF_ACCOUNT_ID`, `CF_GATEWAY_ID`, `CF_AIG_TOKEN` (`npx wrangler secret list`).
- [ ] AI Gateway `dynamic/text_gen` and `dynamic/audio_gen` routes are configured and currently routing successfully (check the AI Gateway dashboard).
- [ ] R2 lifecycle rule `recorder-tts-7d` exists with prefix `recorder/tts/`:
  ```bash
  npx wrangler r2 bucket lifecycle add spooool-videos recorder-tts-7d recorder/tts/ --expire-days 7 --force
  ```
- [ ] `ComposerAgent` DO migration applied (`wrangler deploy` output mentions `do_v4`).

### Auto mode happy path

- [ ] Sign in as a verified user.
- [ ] Open `/create`. Pick "The Hero's Journey".
- [ ] Click **Auto**. Type prompt: `"A junior developer learns Cloudflare Workers and ships their first app"`.
- [ ] Click **Generate video**.
- [ ] Progress bar appears, climbs to 100% within ~2 minutes.
- [ ] Browser navigates to `/watch/{videoId}`.
- [ ] Video plays end-to-end with TTS voiceover audible and in sync with on-screen text.

### Guided mode happy path

- [ ] Sign in as a verified user, open `/create`, switch to **Guided**.
- [ ] Walk through all 7 hero-journey questions, answering plausibly.
- [ ] Click **Generate video** on the completion screen.
- [ ] Status updates stream: drafting → planning → tts → rendering.
- [ ] Browser navigates to `/watch/{videoId}` on completion.

### Failure surfaces

- [ ] Submit auto mode with banned content (e.g., violent prompt) → friendly error message ("Generation failed, please try rephrasing your prompt.").
- [ ] Submit empty prompt → 400 with form-level error.
- [ ] Submit 6 prompts within an hour → 429 (rate-limited via `CREATE_BUCKET`).
- [ ] Refresh the browser mid-guided-session → wizard resumes from the same question.

### Common issues

| Symptom | Likely cause | Fix |
|---|---|---|
| Auto mode hangs at "Queued…" forever | `dynamic/text_gen` route misconfigured, container can't reach R2 to upload TTS, or container env vars missing | Check `wrangler tail`; check container `instances` state |
| TTS audio missing in rendered video | `recorder/tts/{jobId}.mp3` not in R2 (TTS upload failed) | Re-trigger; check container logs for `Missing TTS audio` failure |
| WebSocket fails to connect (Guided mode) | Origin not in trustedOrigins; SPA served from a different host than the worker | Verify `auth.pdx.software` route is still attached |
```

- [ ] **Step 2: Commit**

```bash
git add docs/runbooks/recorder-smoke-test.md
git commit -m "docs(create): smoke runbook for prompt-to-video"
```

---

## Self-review checklist

After implementation, confirm each spec section has at least one task implementing it:

- [ ] `create_sessions` migration with FKs + indexes (Task 2)
- [ ] Template registry + types + `hero-journey` (Task 3)
- [ ] LLM tools (`draftScript`, `planScenes`) with retries + caps (Task 4)
- [ ] `synthesizeTts` with content-policy masking (Task 5)
- [ ] `finalizeRender` with submitRenderJob injection (Task 6)
- [ ] `submitRenderJob` extracted from sub-#1's render.ts (Task 1)
- [ ] `ComposerAgent` DO with full Q&A state machine + generate() (Task 7)
- [ ] CMA one-shot wrapper (Task 8)
- [ ] Worker routes for templates/auto/sessions/jobs (Task 9)
- [ ] DO HTTP wrapper + WebSocket (Tasks 10, 11)
- [ ] `wrangler.toml` DO binding + migration + secret documentation (Task 12)
- [ ] `SpoooolExplainer` Remotion composition (Task 13)
- [ ] Container audio download support + new image push (Task 14)
- [ ] Frontend client + types (Task 15)
- [ ] `AutoMode` (Task 16) + `GuidedMode` (Task 17)
- [ ] `/create` route + page (Task 18)
- [ ] Abandoned-sessions cron sweep (Task 19)
- [ ] Smoke runbook + R2 lifecycle (Task 20)

### Manual post-merge ops

- [ ] `npx wrangler r2 bucket lifecycle add spooool-videos recorder-tts-7d recorder/tts/ --expire-days 7 --force`
- [ ] If using the legacy global API key: rotate to a scoped CF API token before next deploy.
- [ ] Verify `CF_ACCOUNT_ID`, `CF_GATEWAY_ID`, `CF_AIG_TOKEN` set as worker secrets.
- [ ] Configure AI Gateway routes if not already present:
  - `dynamic/text_gen` (any modern Claude / GPT-class model)
  - `dynamic/audio_gen` (TTS, e.g., ElevenLabs or OpenAI TTS routed through gateway)
