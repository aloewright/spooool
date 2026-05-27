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
import { draftScript, planScenes, synthesizeTts, finalizeRender, type AIBindingEnv, type AIGatewayEnv, type R2BindingEnv } from './create-tools';
import type { RenderEnv } from './render';

export interface ComposerAgentEnv extends AIGatewayEnv, R2BindingEnv, AIBindingEnv, RenderEnv {}

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
