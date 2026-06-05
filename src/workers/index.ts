import { Hono } from 'hono';
import { cors } from 'hono/cors';
import { analyticsRoutes } from './analytics';
import { accountRoutes, runDeletionSweep } from './account';
import { ChannelSubscriberDO } from './channel-do';
import { costsRoutes, runCostMonitorSweep } from './costs';
import { dmcaRoutes, runDmcaRestoreSweep } from './dmca';
import { handleEncodingMessage } from './encoding';
import { transitionVideoStatus } from './video-status';
import { handleAiGenMessage } from './ai-video-consumer';
import { createAuth, type AuthEnv } from '../auth';
import { channelRoutes } from './channels';
import { commentRoutes } from './comments';
import { csrfProtection, parseAllowedOrigins } from './csrf';
import { buildHealthReport, healthRoutes, storeHealthSnapshot } from './health';
import { statusRoutes } from './status';
import { lifecycleRoutes } from './lifecycle';
import { likeRoutes } from './likes';
import { moderationRoutes } from './moderation';
import { oembedRoutes } from './oembed';
import { ogMetaRoutes } from './og-meta';
import {
  AUTH_WRITE_BUCKET,
  clientIp,
  rateLimit,
  rateLimitHeaders,
} from './rate-limit';
import { RateLimiterDO } from './rate-limit-do';
import { relatedRoutes } from './related';
import { rolesRoutes } from './roles';
import { securityHeaders } from './security-headers';
import { rumRoutes } from './rum';
import { searchRoutes } from './search';
import { seoRoutes } from './seo';
import { tagRoutes } from './tags';
import { handleStreamWebhook } from './stream-webhook';
import { handlePolarWebhook } from './polar-webhook';
import { subscriptionRoutes } from './subscriptions';
import { thumbnailRoutes } from './thumbnails';
import { userRoutes } from './users';
import { renderRoutes, runStuckJobSweep, type RenderEnv } from './render';
import { createRoutes, runAbandonedSessionsSweep, type CreateEnv } from './create';
import { studioRoutes, type StudioEnv } from './studio';
import { studioAnimationRoutes, type StudioAnimationEnv } from './studio-animation';
import { feedRoutes, type FeedsEnv } from './feeds';
import { warmFeedCaches } from './feed-warm';
import type { AiGatewayMode } from './ai-gateway';
import type { TurnstileEnv } from './turnstile';
import { streamUploadRoutes, type StreamUploadEnv } from './stream-upload';
import { videoRoutes, type VideoRoutesEnv } from './videos';
import { watchHistoryRoutes } from './watch-history';
import { payoutsRoutes, type PayoutsEnv } from './payouts';
import * as Sentry from '@sentry/cloudflare';

type SessionUser = {
  id: string;
  email: string;
  name: string;
  emailVerified: boolean;
};

type EnvBindings = AuthEnv & VideoRoutesEnv & RenderEnv & CreateEnv & StudioEnv & StudioAnimationEnv & StreamUploadEnv & FeedsEnv & PayoutsEnv & TurnstileEnv & {
  ENCODE_CONTAINER: DurableObjectNamespace;
  RATE_LIMITER?: DurableObjectNamespace;
  CF_STREAM_WEBHOOK_SECRET?: string;
  POLAR_WEBHOOK_SECRET?: string;
  ALLOWED_ORIGINS?: string;
  ADMIN_EMAILS?: string;
  SENTRY_DSN?: string;
  CF_VERSION_METADATA?: { id: string; tag?: string };
  // ALO-176: storage cost alert threshold in bytes. Defaults to 100 GiB when
  // unset. The daily cron mails ADMIN_EMAILS once a day if SUM(videos.bytes)
  // crosses the threshold.
  COST_STORAGE_ALERT_BYTES?: string;
  // Cloudflare static assets binding (auto-injected when [assets] is set in
  // wrangler.toml). Used by ogMetaRoutes to fetch index.html and HTMLRewriter
  // it with per-video OG tags.
  ASSETS: { fetch: (req: Request) => Promise<Response> };
  // E11 ALO-642: selects the AI-Gateway transport mode for ai-gateway.ts.
  // 'gateway-binding' (default) uses { binding: env.AI.gateway('x') };
  // 'run-gateway' uses the env.AI.run('@cf/..', .., { gateway: { id: 'x' } })
  // custom adapter. Never plain { binding: env.AI } (drops observability).
  AI_GATEWAY_MODE?: AiGatewayMode;
  // YouTube Data API v3 key for custom feeds (src/workers/youtube.ts). A
  // Cloudflare *secret* (Doppler-synced), NOT a [vars] entry. Optional so the
  // worker still boots without it; YouTube sources just return an error result.
  YOUTUBE_API_KEY?: string;
};

type Variables = {
  user: SessionUser | null;
};

const app = new Hono<{ Bindings: EnvBindings; Variables: Variables }>();

app.use('*', securityHeaders());
app.use('*', cors({ origin: (origin) => origin, credentials: true }));

app.use('/api/*', async (c, next) => {
  const allowedOrigins = parseAllowedOrigins(c.env.ALLOWED_ORIGINS);
  return csrfProtection({
    allowedOrigins,
    // /api/rum is fire-and-forget telemetry; sendBeacon can omit Origin in
    // some browsers and we'd rather lose CSRF protection there than lose
    // visibility — the endpoint only writes Analytics Engine datapoints.
    exemptPaths: ['/api/webhooks/*', '/api/rum'],
  })(c, next);
});

app.post('/api/webhooks/stream', handleStreamWebhook());
app.post('/api/webhooks/polar', handlePolarWebhook());

// Encode container callbacks — called by EncoderContainer with x-render-secret.
// These sit outside CSRF middleware (same exemption as other webhooks).
function timingSafeEqual(a: string, b: string): boolean {
  const enc = new TextEncoder();
  const ab = enc.encode(a), bb = enc.encode(b);
  const len = Math.max(ab.length, bb.length);
  let diff = ab.length ^ bb.length;
  for (let i = 0; i < len; i++) diff |= (ab[i] ?? 0) ^ (bb[i] ?? 0);
  return diff === 0;
}

app.post('/api/webhooks/encode/:id/complete', async (c) => {
  const secret = c.env.RENDER_CALLBACK_SECRET;
  if (!secret || !timingSafeEqual(c.req.header('x-render-secret') ?? '', secret)) {
    return c.json({ error: 'Unauthorized' }, 401);
  }
  const videoId = c.req.param('id');
  const body = await c.req.json().catch(() => null) as { masterKey?: string } | null;
  if (!body?.masterKey) return c.json({ error: 'masterKey required' }, 400);
  await transitionVideoStatus(c.env.DB, videoId, 'ready');
  console.log('[encode] complete', { videoId, masterKey: body.masterKey });
  return c.json({ ok: true });
});

app.post('/api/webhooks/encode/:id/fail', async (c) => {
  const secret = c.env.RENDER_CALLBACK_SECRET;
  if (!secret || !timingSafeEqual(c.req.header('x-render-secret') ?? '', secret)) {
    return c.json({ error: 'Unauthorized' }, 401);
  }
  const videoId = c.req.param('id');
  const body = await c.req.json().catch(() => null) as { error?: string } | null;
  await transitionVideoStatus(c.env.DB, videoId, 'failed');
  console.error('[encode] failed', { videoId, error: body?.error });
  return c.json({ ok: true });
});

// /api/health is a public liveness probe — no auth, no CSRF body checks
// (the global CSRF middleware exempts safe methods, so GET passes through).
app.route('/', healthRoutes);

app.all('/api/auth/*', async (c) => {
  // ALO-168: per-IP rate limit on state-changing auth calls (sign-in, sign-up,
  // password reset, etc.). GET requests like /api/auth/get-session pass
  // through — they're idempotent and hit better-auth's session cache.
  const method = c.req.method.toUpperCase();
  if (method !== 'GET' && method !== 'HEAD') {
    const ip = clientIp(c.req.raw);
    const rl = await rateLimit({ ns: c.env.RATE_LIMITER, bucket: AUTH_WRITE_BUCKET, identity: ip });
    if (!rl.allowed) {
      return c.json(
        { error: 'Too many auth requests. Try again shortly.' },
        429,
        rateLimitHeaders(rl),
      );
    }
  }
  const auth = createAuth(c.env);
  return auth.handler(c.req.raw);
});

app.use('/api/*', async (c, next) => {
  const auth = createAuth(c.env);
  const session = await auth.api.getSession({ headers: c.req.raw.headers });
  let sessionUser: SessionUser | null = null;
  if (session) {
    const u = session.user as { id: string; email: string; name: string; emailVerified?: unknown };
    sessionUser = {
      id: u.id,
      email: u.email,
      name: u.name,
      // better-auth stores emailVerified as INTEGER 0/1 in D1; the JS surface
      // sometimes hands it back as a number. Normalize so callers can rely on
      // a boolean (ALO-128).
      emailVerified: u.emailVerified === true || u.emailVerified === 1,
    };
    const banned = await c.env.DB.prepare('SELECT banned_at FROM user WHERE id = ?')
      .bind(sessionUser.id)
      .first<{ banned_at: number | null }>();
    if (banned?.banned_at != null) {
      sessionUser = null;
    }
  }
  c.set('user', sessionUser);
  await next();
});

app.route('/', thumbnailRoutes);
app.route('/', userRoutes);
app.route('/', channelRoutes);
app.route('/', searchRoutes);
app.route('/', likeRoutes);
app.route('/', commentRoutes);
app.route('/', analyticsRoutes);
app.route('/', subscriptionRoutes);
app.route('/', rumRoutes);
app.route('/', moderationRoutes);
app.route('/', rolesRoutes);
app.route('/', accountRoutes);
app.route('/', dmcaRoutes);
app.route('/', costsRoutes);
app.route('/', lifecycleRoutes);
app.route('/', videoRoutes);
app.route('/', relatedRoutes);
app.route('/', renderRoutes);
app.route('/', createRoutes);
app.route('/', studioAnimationRoutes);
app.route('/', studioRoutes);
app.route('/', streamUploadRoutes);
app.route('/', watchHistoryRoutes);
app.route('/', payoutsRoutes);
app.route('/', seoRoutes);
app.route('/', oembedRoutes);
app.route('/', statusRoutes);
app.route('/', tagRoutes);
app.route('/', feedRoutes);
// /watch/:id is intercepted to inject per-video OG tags before falling
// through to the SPA HTML (ALO-158). Mounted last so /api/* and other
// dynamic routes always win.
app.route('/', ogMetaRoutes);

export { ChannelSubscriberDO, RateLimiterDO };
export { RenderContainer } from './render-container';
export { EncoderContainer } from './encoder-container';
export { ComposerAgent } from './composer-agent-do';

const workerHandlers = {
  fetch: app.fetch,
  async queue(batch: MessageBatch<unknown>, env: EnvBindings): Promise<void> {
    for (const message of batch.messages) {
      try {
        if (batch.queue === 'ai-gen') {
          // handleAiGenMessage never throws (errors → status='failed' + ack).
          // Retrying gen-video re-bills Veo, so we always ack regardless.
          await handleAiGenMessage(env, message.body);
        } else {
          await handleEncodingMessage(env, message.body);
        }
        message.ack();
      } catch (error) {
        console.error('video-encoding queue message failed', {
          error: error instanceof Error ? error.message : String(error),
        });
        message.retry();
      }
    }
  },
  async scheduled(controller: ScheduledController, env: EnvBindings, ctx: ExecutionContext): Promise<void> {
    ctx.waitUntil(
      (async () => {
        try {
          if (controller.cron === '*/5 * * * *') {
            // Frequent sweep: render-job timeout cleanup + abandoned create_sessions
            await runStuckJobSweep(env.DB);
            await runAbandonedSessionsSweep(env.DB);
            // Store a health snapshot so /api/status/uptime has data to plot.
            const healthReport = await buildHealthReport(env);
            await storeHealthSnapshot(env.DB, healthReport);
            // ALO-feeds: warm cheap YouTube source caches for recently-viewed feeds.
            const warmed = await warmFeedCaches(env);
            if (warmed > 0) console.log('[feed-warm]', { cron: controller.cron, warmed });
            return;
          }
          if (controller.cron !== '0 2 * * *') {
            console.warn('[scheduled] unrecognized cron', { cron: controller.cron });
            return;
          }
          // Daily 02:00 UTC heavy sweeps
          // ALO-132: hard-delete users whose 30-day grace window has elapsed.
          // The cron is configured in wrangler.toml under [triggers] crons.
          const stats = await runDeletionSweep(env);
          if (stats.length > 0) {
            console.log('[deletion-sweep]', { cron: controller.cron, deleted: stats });
          }
          const restored = await runDmcaRestoreSweep(env);
          if (restored.length > 0) {
            console.log('[dmca-restore-sweep]', { cron: controller.cron, restored });
          }
          // ALO-176: cost monitor — log even when no alert fires so we have
          // a daily heartbeat in Workers Logs to chart bill growth against.
          const costs = await runCostMonitorSweep(env);
          console.log('[cost-monitor]', {
            cron: controller.cron,
            alerts: costs.alerts.length,
            sent: costs.sent,
            reason: costs.reason,
          });
        } catch (err) {
          console.error('scheduled sweep failed', {
            error: err instanceof Error ? err.message : String(err),
          });
        }
      })(),
    );
  },
};

export default Sentry.withSentry(
  (env: EnvBindings) => ({
    dsn: env.SENTRY_DSN ?? '',
    tracesSampleRate: 0.1,
  }),
  workerHandlers,
);
