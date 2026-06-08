// /embed/:id — serves the SPA shell with relaxed framing headers so the
// player can be embedded on third-party sites. The page itself is the same
// index.html; the SPA's React Router handles rendering the Embed component.
// Security headers are patched to frame-ancestors:* by the securityHeaders()
// middleware (which checks req.path.startsWith('/embed/')).

import { Hono } from 'hono';

export interface EmbedPageEnv {
  ASSETS: { fetch: (req: Request) => Promise<Response> };
}

export const embedPageRoutes = new Hono<{ Bindings: EmbedPageEnv }>();

embedPageRoutes.get('/embed/:id', async (c) => {
  const assetReq = new Request(new URL('/index.html', c.req.url).toString(), {
    method: 'GET',
    headers: c.req.raw.headers,
  });
  const assetRes = await c.env.ASSETS.fetch(assetReq);
  // If the asset binding can't serve the SPA shell, fall through to a 404
  // rather than erroring — the viewer sees nothing and no exception is thrown.
  if (!assetRes.ok || !assetRes.headers.get('content-type')?.includes('text/html')) {
    return assetRes;
  }
  // Return a mutable copy so the securityHeaders() middleware can set the
  // embed-friendly headers on this response object.
  return new Response(assetRes.body, {
    status: assetRes.status,
    headers: assetRes.headers,
  });
});
