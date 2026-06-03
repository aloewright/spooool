// AI Studio routes (E11). POST /api/studio/chat streams an @tanstack/ai chat
// response as SSE. Model selection + system prompt are server-controlled; the
// client only sends user/assistant turns. Generation is gateway-routed via
// ai-gateway.ts (transport mode owned there; default run-gateway).
import { Hono } from 'hono';
import { z } from 'zod';
import { chat, toServerSentEventsResponse } from '@tanstack/ai';
import { gatewayChat, type AiGatewayEnv, type AiGatewayMode } from './ai-gateway';
import type { AIBindingEnv } from './create-tools';
import { STUDIO_GEN_BUCKET, rateLimit, rateLimitHeaders } from './rate-limit';

export interface StudioEnv extends AIBindingEnv {
  RATE_LIMITER?: DurableObjectNamespace;
  AI_GATEWAY_MODE?: AiGatewayMode;
}

interface SessionUser { id: string; emailVerified: boolean }
type StudioVariables = { user: SessionUser | null };

const STUDIO_SYSTEM_PROMPT =
  "You are spooool's creative studio assistant. Help creators brainstorm video ideas, " +
  'scripts, titles, descriptions, and thumbnails. Be concise and practical.';

const chatBodySchema = z.object({
  messages: z.array(z.object({
    role: z.enum(['user', 'assistant']),
    content: z.string().min(1).max(8000),
  })).min(1).max(50),
});

export const studioRoutes = new Hono<{ Bindings: StudioEnv; Variables: StudioVariables }>();

studioRoutes.post('/api/studio/chat', async (c) => {
  const user = c.get('user');
  if (!user) return c.json({ error: 'Unauthorized' }, 401);
  if (!user.emailVerified) return c.json({ error: 'Email verification required' }, 403);

  const rl = await rateLimit({ ns: c.env.RATE_LIMITER, bucket: STUDIO_GEN_BUCKET, identity: user.id });
  if (!rl.allowed) return c.json({ error: 'Too many studio requests. Try again shortly.' }, 429, rateLimitHeaders(rl));

  const raw = await c.req.json().catch(() => null);
  const parsed = chatBodySchema.safeParse(raw);
  if (!parsed.success) return c.json({ error: 'Invalid body', details: parsed.error.flatten() }, 400);

  // Cast: AIBindingEnv.AI.gateway returns Promise<unknown> while AiGatewayEnv's
  // CloudflareAiGateway.run returns Promise<Response> — a tsc-only divergence
  // bridged at runtime by the real Ai binding. Same pattern as create-tools.ts.
  const stream = chat({
    adapter: gatewayChat(c.env as unknown as AiGatewayEnv),
    systemPrompts: [STUDIO_SYSTEM_PROMPT],
    messages: parsed.data.messages,
  });
  return toServerSentEventsResponse(stream);
});
