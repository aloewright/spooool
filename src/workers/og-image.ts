// Dynamic OG card images — 1200×630 PNG with title + channel name overlay for
// social sharing (Twitter, Facebook, Discord, etc.).
//
// Route: GET /api/og/:videoId.png
//
// Strategy:
//   1. Fetch video metadata from D1; 404 if missing / not public.
//   2. Parallel: init resvg WASM + load Inter font (KV-cached) + fetch thumbnail.
//   3. satori converts a plain-object VNode tree to SVG.
//   4. resvg-wasm converts SVG to a 1200×630 PNG.
//   5. Store result in Cloudflare's Cache API (1 h TTL) so repeat scraper
//      hits are served without re-running the worker.
//
// Fallback: if image generation errors (bad WASM env, font fetch failure, etc.)
// the route redirects to the video's raw thumbnail URL so the meta tag still
// resolves to something valid.

import { Hono } from 'hono';
import satori from 'satori';
import { initWasm, Resvg } from '@resvg/resvg-wasm';
// @ts-expect-error — wasm modules have no TS types; wrangler resolves at bundle time
import resvgWasmModule from '@resvg/resvg-wasm/index_bg.wasm';
import { isPublicViewable } from './og-meta';

const CARD_W = 1200;
const CARD_H = 630;
/** KV key for the Inter font blob (7-day TTL — font files are immutable). */
const FONT_KV_KEY = 'og:font:inter-400';
/** Edge-cache TTL for generated PNGs, in seconds. */
const IMG_TTL_SEC = 3600;

export interface OgImageEnv {
  DB: D1Database;
  CACHE: KVNamespace;
}

// ── resvg WASM singleton ────────────────────────────────────────────────────
// initWasm must only run once per isolate. Storing the promise here means
// concurrent cold-start requests coalesce on the same initialisation call
// rather than racing on double-init.
let wasmReady: Promise<void> | null = null;

function ensureWasm(): Promise<void> {
  if (!wasmReady) {
    wasmReady = initWasm(resvgWasmModule as WebAssembly.Module);
  }
  return wasmReady;
}

// ── Font loader ─────────────────────────────────────────────────────────────
// Fetch Inter Regular from jsDelivr and persist raw bytes in KV so every
// subsequent cold-start reads from KV (fast) rather than the CDN (slow).
async function loadFont(kv: KVNamespace): Promise<ArrayBuffer> {
  const cached = await kv.get(FONT_KV_KEY, 'arrayBuffer');
  if (cached) return cached;

  const res = await fetch(
    'https://cdn.jsdelivr.net/npm/@fontsource/inter@5/files/inter-latin-400-normal.woff',
  );
  if (!res.ok) throw new Error(`font fetch ${res.status}`);
  const buf = await res.arrayBuffer();
  await kv.put(FONT_KV_KEY, buf, { expirationTtl: 7 * 24 * 3600 });
  return buf;
}

// ── Thumbnail → data URL ────────────────────────────────────────────────────
// satori only accepts local images as data URLs. We fetch the thumbnail,
// base64-encode it in chunks to avoid call-stack overflow, and wrap it.
// Returns null if the thumbnail is unavailable so the caller can use a
// gradient fallback instead.
async function thumbnailDataUrl(url: string | null): Promise<string | null> {
  if (!url) return null;
  try {
    const res = await fetch(url, { cf: { cacheTtl: 3600 } } as RequestInit);
    if (!res.ok) return null;
    const ct = res.headers.get('content-type') ?? 'image/jpeg';
    const bytes = new Uint8Array(await res.arrayBuffer());
    let b64 = '';
    const CHUNK = 8192;
    for (let i = 0; i < bytes.length; i += CHUNK) {
      const slice = bytes.subarray(i, i + CHUNK);
      let str = '';
      for (let j = 0; j < slice.length; j++) str += String.fromCharCode(slice[j]);
      b64 += btoa(str);
    }
    return `data:${ct};base64,${b64}`;
  } catch {
    return null;
  }
}

function clip(s: string, max: number): string {
  if (s.length <= max) return s;
  return `${s.slice(0, max - 1)}…`;
}

// ── Card layout ─────────────────────────────────────────────────────────────
// Plain-object VNode tree — satori accepts this without React imported.
function buildCard(opts: { title: string; channel: string | null; thumbUrl: string | null }) {
  const { title, channel, thumbUrl } = opts;

  const background = thumbUrl
    ? {
        type: 'img',
        props: {
          src: thumbUrl,
          style: {
            position: 'absolute' as const,
            top: 0,
            left: 0,
            width: CARD_W,
            height: CARD_H,
            objectFit: 'cover' as const,
          },
        },
      }
    : {
        type: 'div',
        props: {
          style: {
            position: 'absolute' as const,
            top: 0,
            left: 0,
            width: CARD_W,
            height: CARD_H,
            background: 'linear-gradient(135deg, #0f0f23 0%, #312e81 60%, #0f172a 100%)',
          },
        },
      };

  return {
    type: 'div',
    props: {
      style: {
        width: CARD_W,
        height: CARD_H,
        display: 'flex',
        fontFamily: 'Inter',
        backgroundColor: '#0f0f23',
        overflow: 'hidden',
        position: 'relative' as const,
      },
      children: [
        background,
        // Gradient scrim so text is legible over any thumbnail
        {
          type: 'div',
          props: {
            style: {
              position: 'absolute' as const,
              top: 0,
              left: 0,
              width: CARD_W,
              height: CARD_H,
              background:
                'linear-gradient(to bottom, rgba(0,0,0,0.10) 0%, rgba(0,0,0,0.50) 45%, rgba(0,0,0,0.88) 100%)',
            },
          },
        },
        // Spooool wordmark — top-left
        {
          type: 'div',
          props: {
            style: {
              position: 'absolute' as const,
              top: 48,
              left: 60,
              display: 'flex',
              alignItems: 'center',
              gap: 12,
            },
            children: [
              {
                type: 'div',
                props: {
                  style: {
                    width: 40,
                    height: 40,
                    borderRadius: 10,
                    backgroundColor: '#6366f1',
                    display: 'flex',
                    alignItems: 'center',
                    justifyContent: 'center',
                    fontSize: 22,
                    color: '#fff',
                  },
                  children: '▶',
                },
              },
              {
                type: 'div',
                props: {
                  style: {
                    fontSize: 30,
                    fontWeight: 700,
                    color: '#ffffff',
                    letterSpacing: -0.5,
                  },
                  children: 'Spooool',
                },
              },
            ],
          },
        },
        // Bottom text: title + channel
        {
          type: 'div',
          props: {
            style: {
              position: 'absolute' as const,
              bottom: 0,
              left: 0,
              right: 0,
              padding: '0 60px 56px',
              display: 'flex',
              flexDirection: 'column' as const,
              gap: 16,
            },
            children: [
              {
                type: 'div',
                props: {
                  style: {
                    fontSize: 54,
                    fontWeight: 700,
                    color: '#ffffff',
                    lineHeight: 1.15,
                    letterSpacing: -1.5,
                  },
                  children: clip(title || 'Untitled', 80),
                },
              },
              ...(channel
                ? [
                    {
                      type: 'div',
                      props: {
                        style: {
                          fontSize: 30,
                          fontWeight: 400,
                          color: 'rgba(255,255,255,0.70)',
                        },
                        children: clip(channel, 60),
                      },
                    },
                  ]
                : []),
            ],
          },
        },
      ],
    },
  };
}

// ── Route ───────────────────────────────────────────────────────────────────
export const ogImageRoutes = new Hono<{ Bindings: OgImageEnv }>();

ogImageRoutes.get('/api/og/:videoId.png', async (c) => {
  const videoId = c.req.param('videoId');
  if (!videoId || videoId.length > 128) return c.notFound();

  // Cloudflare's Cache API check — may already have the PNG from a prior scrape.
  const cacheKey = new Request(new URL(c.req.url).toString());
  const edgeCache = caches.default;
  const hit = await edgeCache.match(cacheKey);
  if (hit) return hit;

  const video = await c.env.DB.prepare(
    `SELECT v.id, v.title, v.thumbnail_url, v.status,
            v.hidden_at, v.dmca_status, v.deleted_at,
            u.name AS channel_name
     FROM videos v
     LEFT JOIN user u ON u.id = v.user_id
     WHERE v.id = ?`,
  )
    .bind(videoId)
    .first<{
      id: string;
      title: string;
      thumbnail_url: string | null;
      status: string | null;
      hidden_at: string | null;
      dmca_status: string | null;
      deleted_at: string | null;
      channel_name: string | null;
    }>();

  if (!video || !isPublicViewable(video)) return c.notFound();

  const origin = new URL(c.req.url).origin;
  const fallbackUrl = video.thumbnail_url ?? `${origin}/icon.png`;

  try {
    // Parallelise the three slow operations
    const [fontData, thumbUrl] = await Promise.all([
      loadFont(c.env.CACHE),
      thumbnailDataUrl(video.thumbnail_url),
      ensureWasm(),
    ]);

    const element = buildCard({ title: video.title, channel: video.channel_name, thumbUrl });

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const svg = await satori(element as any, {
      width: CARD_W,
      height: CARD_H,
      fonts: [{ name: 'Inter', data: fontData, weight: 400, style: 'normal' }],
    });

    const pngData = new Resvg(svg, { fitTo: { mode: 'width', value: CARD_W } })
      .render()
      .asPng();

    const response = new Response(pngData, {
      headers: {
        'content-type': 'image/png',
        'cache-control': `public, max-age=${IMG_TTL_SEC}, s-maxage=${IMG_TTL_SEC}, stale-while-revalidate=86400`,
      },
    });

    try {
      c.executionCtx.waitUntil(edgeCache.put(cacheKey, response.clone()));
    } catch {
      // executionCtx unavailable in local/test environments — ignore
    }

    return response;
  } catch (err) {
    console.error('[og-image] generation failed', { videoId, err });
    return c.redirect(fallbackUrl, 302);
  }
});
