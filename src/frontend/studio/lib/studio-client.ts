// SSE connection for the AI Studio chat endpoint (ALO-644's POST /api/studio/chat).
// credentials:'same-origin' sends the session cookie; same-origin keeps the CSRF
// Origin check happy. Used by AIStudio's useChat().
import { fetchServerSentEvents } from '@tanstack/ai-client';

// Re-export the canonical ApiError so callers get the same class reference
// (instanceof checks require the same class object, not two separate copies).
import { ApiError } from '../../create/lib/create-client';
export { ApiError };

export function studioChatConnection() {
  return fetchServerSentEvents('/api/studio/chat', () => ({ credentials: 'same-origin' as const }));
}

const IMAGE_FETCH_TIMEOUT_MS = 30_000; // image gen is slower than a JSON call

export interface GeneratedImage {
  assetId: string;
  r2Key: string;
  bytes: number;
  dataUrl: string;
}

async function timedFetch(input: string, init: RequestInit = {}): Promise<Response> {
  const signal = init.signal ?? AbortSignal.timeout(IMAGE_FETCH_TIMEOUT_MS);
  return fetch(input, { credentials: 'same-origin', ...init, signal });
}

async function throwIfNotOk(res: Response, route: string): Promise<void> {
  if (res.ok) return;
  const body = await res.json().catch(() => null);
  const msg =
    body && typeof body === 'object' && 'error' in body
      ? String((body as { error: unknown }).error)
      : `HTTP ${res.status}`;
  throw new ApiError(res.status, route, body, msg);
}

export async function postImage(prompt: string): Promise<GeneratedImage> {
  const route = '/api/studio/image';
  const res = await timedFetch(route, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ prompt }),
  });
  await throwIfNotOk(res, route);
  return (await res.json()) as GeneratedImage;
}

export interface AnimationRequestBody {
  prompt: string;
  aspectRatio: '16:9' | '9:16' | '1:1';
  durationSeconds: 15 | 30 | 45 | 60 | 90;
  style: 'clean' | 'playful' | 'cinematic' | 'technical' | 'social';
  voiceover: 'none' | 'warm' | 'neutral' | 'energetic';
  useGeneratedImages: boolean;
}

export interface AnimationQueuedResponse {
  jobId: string;
  status: 'queued';
  estimate: { durationSeconds: number; estimatedCostUsd: number };
  generatedAssetCount: number;
}

export interface RenderJobStatus {
  id: string;
  status: 'queued' | 'rendering' | 'completed' | 'failed';
  progress: number;
  outputKey?: string | null;
  videoId?: string | null;
  error?: string | null;
}

export async function postAnimation(body: AnimationRequestBody): Promise<AnimationQueuedResponse> {
  const route = '/api/studio/animation';
  const res = await timedFetch(route, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
  await throwIfNotOk(res, route);
  return (await res.json()) as AnimationQueuedResponse;
}

export async function getRenderJob(jobId: string): Promise<RenderJobStatus> {
  const route = `/api/render/jobs/${jobId}`;
  const res = await timedFetch(route, { method: 'GET' });
  await throwIfNotOk(res, route);
  return (await res.json()) as RenderJobStatus;
}

export async function setThumbnailFromAsset(
  videoId: string,
  assetId: string,
): Promise<{ thumbnail_url: string }> {
  const route = `/api/videos/${videoId}/thumbnail/from-asset`;
  const res = await timedFetch(route, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ asset_id: assetId }),
  });
  await throwIfNotOk(res, route);
  return (await res.json()) as { thumbnail_url: string };
}

export interface VideoChapter {
  startSeconds: number;
  title: string;
}

export interface GeneratedMetadata {
  assetId: string;
  title: string;
  description: string;
  tags: string[];
  chapters: VideoChapter[];
}

export async function generateMetadata(
  videoId: string,
  opts: { projectId?: string; additionalContext?: string } = {},
): Promise<GeneratedMetadata> {
  const route = '/api/studio/metadata';
  const res = await timedFetch(route, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ videoId, ...opts }),
  });
  await throwIfNotOk(res, route);
  return (await res.json()) as GeneratedMetadata;
}
