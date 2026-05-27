// Frontend API client for the prompt-to-video flow.
//
// All HTTPS calls have a 15s timeout (via AbortSignal.timeout) so a hung
// network or a stuck worker can't strand the UI in "Loading…" forever.
// Errors are structured (ApiError) so the form layer can render field-level
// validation hints without re-parsing the response body.

import type { StoryTemplate, TemplateMetadata, Question } from './template';

const FETCH_TIMEOUT_MS = 15_000;

export interface RenderJobStatus {
  id: string;
  status: 'queued' | 'rendering' | 'completed' | 'failed';
  progress: number;
  outputKey: string | null;
  videoId: string | null;
  error: string | null;
}

/** Structured error thrown by every fetch helper in this module. */
export class ApiError extends Error {
  status: number;
  /** The route the request was made to (without origin). */
  route: string;
  /** Parsed JSON body if the server returned JSON. */
  body: unknown;
  /** Zod-style field errors when the server returned `{ details }`. */
  fieldErrors: Record<string, string[]> | null;
  /** Top-level form errors when the server returned `{ details }`. */
  formErrors: string[];

  constructor(status: number, route: string, body: unknown, message: string) {
    super(message);
    this.name = 'ApiError';
    this.status = status;
    this.route = route;
    this.body = body;
    this.fieldErrors = null;
    this.formErrors = [];
    const maybe = body as { details?: { fieldErrors?: Record<string, string[]>; formErrors?: string[] } } | null;
    if (maybe && typeof maybe === 'object' && maybe.details) {
      if (maybe.details.fieldErrors) this.fieldErrors = maybe.details.fieldErrors;
      if (maybe.details.formErrors) this.formErrors = maybe.details.formErrors;
    }
  }
}

async function timedFetch(input: string, init: RequestInit = {}): Promise<Response> {
  const signal = init.signal ?? AbortSignal.timeout(FETCH_TIMEOUT_MS);
  return fetch(input, { credentials: 'same-origin', ...init, signal });
}

async function parseBody(res: Response): Promise<unknown> {
  const ct = res.headers.get('content-type') ?? '';
  if (ct.includes('application/json')) {
    try { return await res.json(); } catch { return null; }
  }
  try { return await res.text(); } catch { return null; }
}

async function throwIfNotOk(res: Response, route: string): Promise<void> {
  if (res.ok) return;
  const body = await parseBody(res);
  const message = (() => {
    if (body && typeof body === 'object' && 'error' in (body as Record<string, unknown>)) {
      const e = (body as { error: unknown }).error;
      if (typeof e === 'string') return e;
    }
    if (typeof body === 'string' && body.length > 0) return body;
    return `Request failed: HTTP ${res.status}`;
  })();
  throw new ApiError(res.status, route, body, message);
}

export async function listTemplates(): Promise<TemplateMetadata[]> {
  const route = '/api/create/templates';
  const res = await timedFetch(route);
  await throwIfNotOk(res, route);
  const body = (await res.json()) as { templates: TemplateMetadata[] };
  return body.templates;
}

export async function getTemplate(id: string): Promise<StoryTemplate> {
  const route = `/api/create/templates/${id}`;
  const res = await timedFetch(route);
  await throwIfNotOk(res, route);
  const body = (await res.json()) as { template: StoryTemplate };
  return body.template;
}

export async function createAutoJob(args: { templateId: string; prompt: string }): Promise<{ jobId: string }> {
  const route = '/api/create/auto';
  const res = await timedFetch(route, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(args),
  });
  await throwIfNotOk(res, route);
  return (await res.json()) as { jobId: string };
}

export async function createSession(args: { templateId: string }): Promise<{ sessionId: string; firstQuestion: Question }> {
  const route = '/api/create/sessions';
  const res = await timedFetch(route, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(args),
  });
  await throwIfNotOk(res, route);
  return (await res.json()) as { sessionId: string; firstQuestion: Question };
}

export function connectSessionStream(sessionId: string): WebSocket {
  const proto = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
  return new WebSocket(`${proto}//${window.location.host}/api/create/sessions/${sessionId}/stream`);
}

export async function fetchJobStatus(jobId: string): Promise<RenderJobStatus> {
  const route = `/api/create/jobs/${jobId}`;
  const res = await timedFetch(route);
  await throwIfNotOk(res, route);
  return (await res.json()) as RenderJobStatus;
}
