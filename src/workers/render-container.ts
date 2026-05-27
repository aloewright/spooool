// Per-account Cloudflare Container that runs Remotion + Chromium + ffmpeg
// to render recorded takes into a final MP4. The actual rendering happens
// inside the container's HTTP server (container/render/src/server.ts);
// this class is just the Worker-side handle CF uses to dispatch and route
// requests to a per-instance container.
//
// The class is keyed on the user id (via DurableObjectNamespace.idFromName)
// so each user's renders run in their own scale-to-zero container.
//
// Env-var forwarding: Cloudflare Containers don't have their own secret
// manager, so we forward the worker's bindings into the container's
// process env at construction time. The container reads them via
// `process.env.*` from `container/render/src/server.ts`:
//   - RENDER_CALLBACK_SECRET   shared secret for container → worker callbacks
//   - R2_ACCESS_KEY_ID          S3 API key for pulling raw takes / pushing renders
//   - R2_SECRET_ACCESS_KEY      paired secret
//   - R2_S3_ENDPOINT            https://<account>.r2.cloudflarestorage.com
//   - R2_BUCKET                 hardcoded — the worker also writes to this bucket
//   - WORKER_BASE_URL           hardcoded — origin the container calls back to

import { Container } from '@cloudflare/containers';

interface RenderContainerEnv {
  RENDER_CALLBACK_SECRET: string;
  R2_ACCESS_KEY_ID: string;
  R2_SECRET_ACCESS_KEY: string;
  R2_S3_ENDPOINT: string;
}

export class RenderContainer extends Container<RenderContainerEnv> {
  defaultPort = 8080;
  // Container processes the render in the background via fire-and-forget
  // `drain()`, so there's no incoming HTTP traffic to reset CF Containers'
  // idle timer. Keep the container alive for up to 10 minutes after the
  // last /render request so the in-progress render can finish + post its
  // /complete callback.
  sleepAfter = '10m';
  // The container needs outbound internet so it can:
  //   - pull recorder takes from R2 via the S3 API
  //   - upload finished MP4s back to R2
  //   - POST /progress / /complete / /fail callbacks to the worker
  // Without this, every outbound fetch from inside the container fails and
  // renders silently stall in the `queued` state.
  enableInternet = true;

  constructor(ctx: DurableObjectState<RenderContainerEnv>, env: RenderContainerEnv) {
    super(ctx, env);
    this.envVars = {
      ...this.envVars,
      RENDER_CALLBACK_SECRET: env.RENDER_CALLBACK_SECRET,
      R2_ACCESS_KEY_ID: env.R2_ACCESS_KEY_ID,
      R2_SECRET_ACCESS_KEY: env.R2_SECRET_ACCESS_KEY,
      R2_S3_ENDPOINT: env.R2_S3_ENDPOINT,
      R2_BUCKET: 'spooool-videos',
      WORKER_BASE_URL: 'https://spooool.com',
    };
  }
}
