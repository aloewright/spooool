// Cloudflare Container DO for the R2+FFmpeg HLS encoding path (ALO-136).
// Uses the same image as RenderContainer (both run server.ts), but keyed
// on a pool so encode jobs distribute across POOL_SIZE instances rather
// than one per user. Separate DO class keeps encode queue slots independent
// of render queue slots.

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

// Distribute encode jobs across the pool by hashing the videoId. A polynomial
// rolling hash (FNV-1a-style) spreads ids far more evenly than summing char
// codes — character-summing collides on anagrams and clusters because input
// ids share an alphabet, leaving pool slots unevenly loaded.
export function getEncoderStub(
  ns: DurableObjectNamespace,
  videoId: string,
): DurableObjectStub {
  let h = 2166136261; // FNV offset basis
  for (let i = 0; i < videoId.length; i++) {
    h ^= videoId.charCodeAt(i);
    h = Math.imul(h, 16777619); // FNV prime
  }
  const slot = (h >>> 0) % POOL_SIZE;
  return ns.get(ns.idFromName(`encoder-${slot}`));
}
