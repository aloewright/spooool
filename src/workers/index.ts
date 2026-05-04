import { Hono } from 'hono';
import { cors } from 'hono/cors';
import { analyticsRoutes } from './analytics';
import { accountRoutes, runDeletionSweep } from './account';
import { ChannelSubscriberDO } from './channel-do';
import { dmcaRoutes, runDmcaRestoreSweep } from './dmca';
import { handleEncodingMessage } from './encoding';
import { createAuth, type AuthEnv } from '../auth';
import { channelRoutes } from './channels';
import { commentRoutes } from './comments';
import { csrfProtection, parseAllowedOrigins } from './csrf';
import { healthRoutes } from './health';
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
import { rolesRoutes } from './roles';
import { securityHeaders } from './security-headers';
import { rumRoutes } from './rum';
import { searchRoutes } from './search';
import { seoRoutes } from './seo';
import { handleStreamWebhook } from './stream-webhook';
import { subscriptionRoutes } from './subscriptions';
import { thumbnailRoutes } from './thumbnails';
import { userRoutes } from './users';
import { videoRoutes, type VideoRoutesEnv } from './videos';
import { watchHistoryRoutes } from './watch-history';
import * as Sentry from '@sentry/cloudflare';

type SessionUser = {
  id: string;
  email: string;
  name: string;
};

type EnvBindings = AuthEnv & VideoRoutesEnv & {
  RATE_LIMITER?: DurableObjectNamespace;
  CF_STREAM_WEBHOOK_SECRET?: string;
  ALLOWED_ORIGINS?: string;
  ADMIN_EMAILS?: string;
  SENTRY_DSN?: string;
  CF_VERSION_METADATA?: { id: string; tag?: string };
  // Cloudflare static assets binding (auto-injected when [assets] is set in
  // wrangler.toml). Used by ogMetaRoutes to fetch index.html and HTMLRewriter
  // it with per-video OG tags.
  ASSETS: { fetch: (req: Request) => Promise<Response> };
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
  let sessionUser = session ? (session.user as SessionUser) : null;
  if (sessionUser) {
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
app.route('/', videoRoutes);
app.route('/', watchHistoryRoutes);
app.route('/', seoRoutes);
app.route('/', oembedRoutes);
// /watch/:id is intercepted to inject per-video OG tags before falling
// through to the SPA HTML (ALO-158). Mounted last so /api/* and other
// dynamic routes always win.
app.route('/', ogMetaRoutes);

export { ChannelSubscriberDO, RateLimiterDO };

const workerHandlers = {
  fetch: app.fetch,
  async queue(batch: MessageBatch<unknown>, env: EnvBindings): Promise<void> {
    for (const message of batch.messages) {
      try {
        await handleEncodingMessage(env, message.body);
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
    // ALO-132: hard-delete users whose 30-day grace window has elapsed.
    // The cron is configured in wrangler.toml under [triggers] crons.
    ctx.waitUntil(
      (async () => {
        try {
          const stats = await runDeletionSweep(env);
          if (stats.length > 0) {
            console.log('[deletion-sweep]', { cron: controller.cron, deleted: stats });
          }
          const restored = await runDmcaRestoreSweep(env);
          if (restored.length > 0) {
            console.log('[dmca-restore-sweep]', { cron: controller.cron, restored });
          }
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
