// Cloudflare Media Transformations helpers (E10). Used by captions to extract
// audio from R2-hosted MP4 sources without calling provider APIs directly.

export interface MediaTransformBinding {
  input(body: ReadableStream | ArrayBuffer | Blob): {
    transform(opts: { width?: number; height?: number; fit?: string }): {
      output(opts: { mode: string; time?: number; duration?: number }): {
        response(): Promise<Response>;
      };
    };
  };
}

export interface MediaTransformEnv {
  MEDIA?: MediaTransformBinding;
  VIDEOS: R2Bucket;
}

/** Extract audio bytes for STT. Prefers MEDIA mode:'audio'; falls back to raw R2 get. */
export async function extractAudioForTranscription(
  env: MediaTransformEnv,
  r2Key: string,
): Promise<{ bytes: Uint8Array; contentType: string }> {
  const obj = await env.VIDEOS.get(r2Key);
  if (!obj) throw new Error(`Source not found: ${r2Key}`);

  if (env.MEDIA) {
    const res = await env.MEDIA
      .input(obj.body)
      .transform({})
      .output({ mode: 'audio' })
      .response();
    if (!res.ok) {
      throw new Error(`MEDIA audio extraction failed: ${res.status}`);
    }
    const buf = await res.arrayBuffer();
    return {
      bytes: new Uint8Array(buf),
      contentType: res.headers.get('content-type') ?? 'audio/mp4',
    };
  }

  // Dev/test fallback when MEDIA binding is not configured. Guard against
  // buffering a large video fully into memory — Workers cap heap near 128MB.
  const MAX_FALLBACK_BYTES = 100 * 1024 * 1024;
  if (typeof obj.size === 'number' && obj.size > MAX_FALLBACK_BYTES) {
    throw new Error(
      `Source ${r2Key} (${obj.size} bytes) exceeds the in-memory fallback limit ` +
        `(${MAX_FALLBACK_BYTES} bytes); configure the MEDIA binding for large files`,
    );
  }
  const buf = await obj.arrayBuffer();
  return {
    bytes: new Uint8Array(buf),
    contentType: obj.httpMetadata?.contentType ?? 'video/mp4',
  };
}
