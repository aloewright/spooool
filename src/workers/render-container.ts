// Per-account Cloudflare Container that runs Remotion + Chromium + ffmpeg
// to render recorded takes into a final MP4. The actual rendering happens
// inside the container's HTTP server (container/render/src/server.ts);
// this class is just the Worker-side handle CF uses to dispatch and route
// requests to a per-instance container.
//
// The class is keyed on the user id (via DurableObjectNamespace.idFromName)
// so each user's renders run in their own scale-to-zero container.
//
// Env-var forwarding: the worker holds RENDER_CALLBACK_SECRET (and any
// other shared secrets) as a wrangler secret. Cloudflare Containers don't
// have their own secret manager, so we forward the values into the
// container's process env at construction time. The container reads them
// via `process.env.*` from `container/render/src/server.ts` to authenticate
// its outgoing callbacks back to the worker.

import { Container } from '@cloudflare/containers';

interface RenderContainerEnv {
  RENDER_CALLBACK_SECRET: string;
}

export class RenderContainer extends Container<RenderContainerEnv> {
  defaultPort = 8080;
  sleepAfter = '60s';

  constructor(ctx: DurableObjectState<RenderContainerEnv>, env: RenderContainerEnv) {
    super(ctx, env);
    this.envVars = {
      ...this.envVars,
      RENDER_CALLBACK_SECRET: env.RENDER_CALLBACK_SECRET,
    };
  }
}
