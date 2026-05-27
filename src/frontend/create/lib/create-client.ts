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
