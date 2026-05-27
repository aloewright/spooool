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
}
