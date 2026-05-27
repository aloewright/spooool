export interface RenderJobStatus {
  id: string;
  status: 'queued' | 'rendering' | 'completed' | 'failed';
  progress: number;
  outputKey: string | null;
  videoId: string | null;
  error: string | null;
}

export async function createRenderJob(args: {
  takeKeys: string[];
  compositionProps: Record<string, unknown>;
}): Promise<{ jobId: string }> {
  const res = await fetch('/api/render/jobs', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    credentials: 'same-origin',
    body: JSON.stringify(args),
  });
  if (!res.ok) {
    const text = await res.text().catch(() => '');
    throw new Error(`Render request failed: ${res.status} ${text}`);
  }
  return res.json() as Promise<{ jobId: string }>;
}

export async function fetchRenderStatus(jobId: string): Promise<RenderJobStatus> {
  const res = await fetch(`/api/render/jobs/${jobId}`, { credentials: 'same-origin' });
  if (!res.ok) throw new Error(`Status fetch failed: ${res.status}`);
  return res.json() as Promise<RenderJobStatus>;
}
