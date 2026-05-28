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
import { draftScript, planScenes, synthesizeTts, finalizeRender, type AIBindingEnv, type AIGatewayEnv, type R2BindingEnv, type SceneSpec } from './create-tools';
import type { RenderEnv } from './render';

export interface ComposerAgentEnv extends AIGatewayEnv, R2BindingEnv, AIBindingEnv, RenderEnv {}

export type AgentStatus = 'questioning' | 'rendering' | 'completed' | 'failed' | 'abandoned';

/**
 * Stage of the auto-mode toolchain. Each tick of the DO alarm runs one
 * stage with a fresh worker-invocation budget, so the full toolchain
 * (draft → plan → tts → finalize) runs across 4 invocations instead of
 * trying to fit inside the route handler's ~10–30s waitUntil cap.
 */
export type AutoStage = 'pending' | 'drafting' | 'planning' | 'tts' | 'rendering' | 'done' | 'failed';

interface PersistedState {
  userId: string;
  templateId: string;
  status: AgentStatus;
  answers: Record<string, string>;
  currentQuestionIdx: number;
  jobId?: string;
  errorMessage?: string;
  // Auto-mode fields (unset for guided sessions):
  autoPrompt?: string;
  autoStage?: AutoStage;
  script?: string;
  scenes?: SceneSpec[];
  ttsR2Key?: string;
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
   * Auto-mode entry point. The /api/create/auto route calls this after it
   * pre-inserts the render_jobs row. We save initial state and schedule an
   * alarm for the first stage — control returns to the caller immediately
   * so the route can respond with the jobId. Subsequent stages run from
   * alarm() with fresh per-invocation budgets.
   */
  async runAutoMode(args: { userId: string; templateId: string; prompt: string; jobId: string }): Promise<void> {
    if (await this.loadState()) throw new Error('DO already initialized for a different session');
    const t = getTemplate(args.templateId);
    if (!t) throw new Error(`Unknown template: ${args.templateId}`);
    await this.saveState({
      userId: args.userId,
      templateId: args.templateId,
      status: 'rendering',
      answers: {},
      currentQuestionIdx: 0,
      jobId: args.jobId,
      autoPrompt: args.prompt,
      autoStage: 'pending',
    });
    // Fire alarm ASAP. CF schedules at the next available moment (sub-second).
    await this.ctx.storage.setAlarm(Date.now());
  }

  /**
   * Mark the render_jobs row failed with the given user-facing message.
   * Best-effort — log on DB error but don't rethrow (the DO has nothing
   * else to do at this point).
   */
  private async failJob(jobId: string, msg: string): Promise<void> {
    try {
      await this.env.DB.prepare(
        `UPDATE render_jobs SET status='failed', error_message=?, updated_at=? WHERE id=?`,
      ).bind(msg, Date.now(), jobId).run();
    } catch (dbErr) {
      console.error('[composer-agent] failed to mark auto job failed', {
        jobId,
        err: dbErr instanceof Error ? dbErr.message : String(dbErr),
      });
    }
  }

  /**
   * DO alarm handler — runs the current auto-mode stage and schedules the
   * next one. Each tick is a fresh worker invocation, so the LLM call in
   * the current stage gets its own 30s budget rather than competing with
   * earlier stages.
   */
  async alarm(): Promise<void> {
    const s = await this.loadState();
    if (!s || !s.autoStage || !s.jobId || !s.autoPrompt) {
      // Not an auto-mode session or already terminal — nothing to do.
      return;
    }
    const jobId = s.jobId;
    const t = this.template();
    const prompt = s.autoPrompt;

    try {
      if (s.autoStage === 'pending' || s.autoStage === 'drafting') {
        const tStage = Date.now();
        console.log('[composer-agent] auto draft_script start', { jobId });
        const { script } = await draftScript({
          template: t,
          answers: { prompt },
          env: this.env,
        });
        console.log('[composer-agent] auto draft_script ok', { jobId, duration_ms: Date.now() - tStage, script_chars: script.length });
        await this.saveState({ ...s, autoStage: 'planning', script });
        await this.ctx.storage.setAlarm(Date.now());
        return;
      }

      if (s.autoStage === 'planning') {
        if (!s.script) throw new Error('planning stage: missing script');
        const tStage = Date.now();
        console.log('[composer-agent] auto plan_scenes start', { jobId });
        const { scenes } = await planScenes({ script: s.script, template: t, env: this.env });
        console.log('[composer-agent] auto plan_scenes ok', { jobId, duration_ms: Date.now() - tStage, scene_count: scenes.length });
        await this.saveState({ ...s, autoStage: 'tts', scenes });
        await this.ctx.storage.setAlarm(Date.now());
        return;
      }

      if (s.autoStage === 'tts') {
        if (!s.script) throw new Error('tts stage: missing script');
        const tStage = Date.now();
        console.log('[composer-agent] auto synthesize_tts start', { jobId });
        // TTS failure is non-fatal — content-policy refusals bubble; other
        // errors get logged and the job proceeds with a silent video.
        let r2Key: string | undefined;
        try {
          const result = await synthesizeTts({ script: s.script, voice: t.voice, jobId, env: this.env });
          r2Key = result.r2Key;
          console.log('[composer-agent] auto synthesize_tts ok', { jobId, duration_ms: Date.now() - tStage, r2Key });
        } catch (err) {
          const msg = err instanceof Error ? err.message : String(err);
          if (/Generation failed, please try rephrasing/.test(msg)) {
            await this.saveState({ ...s, autoStage: 'failed', errorMessage: msg, status: 'failed' });
            await this.failJob(jobId, msg);
            return;
          }
          console.warn('[composer-agent] auto synthesize_tts failed — rendering silent video', { jobId, duration_ms: Date.now() - tStage, msg: msg.slice(0, 200) });
        }
        await this.saveState({ ...s, autoStage: 'rendering', ttsR2Key: r2Key });
        await this.ctx.storage.setAlarm(Date.now());
        return;
      }

      if (s.autoStage === 'rendering') {
        if (!s.scenes) throw new Error('rendering stage: missing scenes');
        const tStage = Date.now();
        console.log('[composer-agent] auto finalize_render start', { jobId });
        await finalizeRender({
          userId: s.userId,
          scenes: s.scenes,
          ttsR2Key: s.ttsR2Key,
          env: this.env,
          existingJobId: jobId,
        });
        console.log('[composer-agent] auto finalize_render ok', { jobId, duration_ms: Date.now() - tStage });
        await this.saveState({ ...s, autoStage: 'done' });
        return;
      }
      // 'done' / 'failed' — nothing to do.
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      console.error('[composer-agent] auto stage failed', { jobId, stage: s.autoStage, msg: msg.slice(0, 200) });
      await this.saveState({ ...s, autoStage: 'failed', errorMessage: msg, status: 'failed' });
      await this.failJob(jobId, msg.slice(0, 200));
    }
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
    // Generate ONE jobId up front and thread it through TTS + finalize so the
    // R2 key (`recorder/tts/{jobId}.mp3`) matches the eventual render_jobs row.
    // submitRenderJob still owns the INSERT here (no existingJobId passed) —
    // unlike the auto-mode route, the WS handler isn't bound by the 30s
    // worker timeout, so we don't need the pre-insert + waitUntil dance.
    const jobId = `j_${crypto.randomUUID().replace(/-/g, '').slice(0, 16)}`;
    await this.saveState({ ...s, status: 'rendering', jobId });
    try {
      onStatus('drafting');
      const { script } = await draftScript({ template: t, answers: s.answers, env: this.env });
      onStatus('planning');
      const { scenes } = await planScenes({ script, template: t, env: this.env });
      onStatus('tts');
      // TTS failure is non-fatal — render silently rather than fail the
      // whole job. Content-policy refusals bubble (they're user-facing).
      let r2Key: string | undefined;
      try {
        const result = await synthesizeTts({ script, voice: t.voice, jobId, env: this.env });
        r2Key = result.r2Key;
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        if (/Generation failed, please try rephrasing/.test(msg)) throw err;
        console.warn('[composer-agent] tts failed — rendering silent video', { jobId, msg: msg.slice(0, 200) });
      }
      onStatus('rendering');
      const { jobId: returnedJobId } = await finalizeRender({
        userId: s.userId,
        scenes,
        ttsR2Key: r2Key,
        env: this.env,
        existingJobId: jobId,
      });
      // returnedJobId === jobId because we passed existingJobId; keep the
      // assignment so a future refactor that drops existingJobId still works.
      await this.saveState({ ...s, status: 'rendering', jobId: returnedJobId });
      return { jobId: returnedJobId };
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      await this.saveState({ ...s, status: 'failed', errorMessage: msg, jobId });
      throw err;
    }
  }

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
      if (request.method === 'POST' && url.pathname === '/run-auto-mode') {
        const body = await request.json() as { userId?: string; templateId?: string; prompt?: string; jobId?: string };
        if (!body.userId || !body.templateId || !body.prompt || !body.jobId) {
          return Response.json({ error: 'userId, templateId, prompt, jobId required' }, { status: 400 });
        }
        await this.runAutoMode({
          userId: body.userId,
          templateId: body.templateId,
          prompt: body.prompt,
          jobId: body.jobId,
        });
        return Response.json({ ok: true, jobId: body.jobId }, { status: 200 });
      }
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
      return new Response('Not found', { status: 404 });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      return Response.json({ error: msg }, { status: 500 });
    }
  }
}
