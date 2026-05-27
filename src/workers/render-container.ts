// Per-account Cloudflare Container that runs Remotion + Chromium + ffmpeg
// to render recorded takes into a final MP4. The actual rendering happens
// inside the container's HTTP server (container/render/src/server.ts);
// this class is just the Worker-side handle CF uses to dispatch and route
// requests to a per-instance container.
//
// The class is keyed on the user id (via DurableObjectNamespace.idFromName)
// so each user's renders run in their own scale-to-zero container.

import { Container } from '@cloudflare/containers';

export class RenderContainer extends Container {
  defaultPort = 8080;
  sleepAfter = '60s';
}
