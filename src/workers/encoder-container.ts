// Cloudflare Container DO for the R2+FFmpeg HLS encoding path (ALO-136).
// Uses the same image as RenderContainer (both run server.ts), but keyed
// on a small pool so encode jobs distribute across ≤POOL_SIZE instances
// rather than one per user. Separate DO class keeps encode queue slots
// independent of render queue slots.

import { Container } from '@cloudflare/containers';

const POOL_SIZE = 10;

interface EncoderContainerEnv {
  RENDER_CALLBACK_SECRET: string;
  R2_ACCESS_KEY_ID: string;
  R2_SECRET_ACCESS_KEY: string;
  R2_S3_ENDPOINT: string;
}

export class EncoderContainer extends Container<EncoderContainerEnv> {
  defaultPort = 8080;
  sleepAfter = '120s';

  constructor(ctx: DurableObjectState<EncoderContainerEnv>, env: EncoderContainerEnv) {
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

// Distribute encode jobs across the pool by hashing the videoId.
export function getEncoderStub(
  ns: DurableObjectNamespace,
  videoId: string,
): DurableObjectStub {
  const slot = [...videoId].reduce((acc, c) => (acc + c.charCodeAt(0)) & 0xffff, 0) % POOL_SIZE;
  return ns.get(ns.idFromName(`encoder-${slot}`));
}
