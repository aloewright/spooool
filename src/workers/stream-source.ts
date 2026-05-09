// Public R2 source endpoint that Cloudflare Stream pulls source bytes from
// when we kick off a /stream/copy job. The URL is HMAC-signed with a short
// expiry so a leaked link can't be replayed past `exp`.
//
// Stream fetches the bytes once and stores its own copy. We don't need the
// endpoint to be authenticated by the user session — the signature is the
// authorization material.

import { Hono } from 'hono';
import { verifyStreamSourceSignature, type EncodingEnv } from './encoding';

export interface StreamSourceEnv extends EncodingEnv {
  VIDEOS: R2Bucket;
}

export const streamSourceRoutes = new Hono<{ Bindings: StreamSourceEnv }>();

streamSourceRoutes.on(['GET', 'HEAD'], '/api/internal/stream-source', async (c) => {
  const key = c.req.query('key');
  const expRaw = c.req.query('exp');
  const sig = c.req.query('sig');
  if (!key || !expRaw || !sig) {
    return c.json({ error: 'Missing key/exp/sig' }, 400);
  }

  const exp = Number(expRaw);
  const verification = await verifyStreamSourceSignature(c.env, key, exp, sig);
  if (!verification.ok) {
    return c.json({ error: 'Invalid signature', reason: verification.reason }, 403);
  }

  const head = await c.env.VIDEOS.head(key);
  if (!head) return c.json({ error: 'Object not found' }, 404);

  const contentType = head.httpMetadata?.contentType ?? 'application/octet-stream';
  if (c.req.method === 'HEAD') {
    return new Response(null, {
      status: 200,
      headers: {
        'Content-Type': contentType,
        'Content-Length': String(head.size),
        'Cache-Control': 'private, no-store',
      },
    });
  }

  const object = await c.env.VIDEOS.get(key);
  if (!object) return c.json({ error: 'Object not found' }, 404);

  return new Response(object.body, {
    status: 200,
    headers: {
      'Content-Type': contentType,
      'Content-Length': String(head.size),
      'Cache-Control': 'private, no-store',
    },
  });
});
