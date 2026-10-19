// Generates a presigned GET URL for a private R2 object using the
// S3-compatible API and AWS Signature V4. The Worker does auth/visibility
// checks, then redirects the client to the presigned URL so large video
// bytes flow directly from R2 rather than through Worker CPU.
//
// R2 credentials required:
//   R2_ACCOUNT_ID       — Cloudflare account ID (hex, from CF dashboard)
//   R2_ACCESS_KEY_ID    — R2 API token access key (r2:object:read scope)
//   R2_SECRET_ACCESS_KEY — R2 API token secret key
//
// Create the token once via:
//   Cloudflare dashboard → R2 → Manage R2 API tokens → Create token
//   (Object-level read, scoped to spooool-videos)

export interface PresignOpts {
  accountId: string;
  accessKeyId: string;
  secretAccessKey: string;
  bucketName: string;
  key: string;
  expiresInSeconds?: number;
  now?: Date;
}

async function hmacSha256(key: ArrayBuffer, message: string): Promise<ArrayBuffer> {
  const cryptoKey = await crypto.subtle.importKey(
    'raw',
    key,
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign'],
  );
  return crypto.subtle.sign('HMAC', cryptoKey, new TextEncoder().encode(message));
}

async function sha256Hex(data: string): Promise<string> {
  const buf = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(data));
  return toHex(buf);
}

function toHex(buf: ArrayBuffer): string {
  return [...new Uint8Array(buf)].map(b => b.toString(16).padStart(2, '0')).join('');
}

// Encodes a key path for the canonical URI: each segment is percent-encoded
// individually so '/' separators are preserved (not double-encoded).
function encodeKey(key: string): string {
  return key.split('/').map(encodeURIComponent).join('/');
}

export async function presignR2GetUrl({
  accountId,
  accessKeyId,
  secretAccessKey,
  bucketName,
  key,
  expiresInSeconds = 3600,
  now = new Date(),
}: PresignOpts): Promise<string> {
  // R2 uses 'auto' as the region for the S3-compatible endpoint.
  const region = 'auto';
  const service = 's3';
  const host = `${accountId}.r2.cloudflarestorage.com`;

  // ISO 8601 compact form: YYYYMMDDTHHmmssZ
  const datetime = now.toISOString().replace(/[-:.]/g, '').slice(0, 15) + 'Z';
  const date = datetime.slice(0, 8);
  const credentialScope = `${date}/${region}/${service}/aws4_request`;

  // Path-style URL: /{bucket}/{key}
  const canonicalUri = `/${bucketName}/${encodeKey(key)}`;

  // Query string params must be sorted lexicographically for the canonical
  // request. X-Amz-Signature is NOT included when building the string-to-sign.
  const queryParams: [string, string][] = (
    [
      ['X-Amz-Algorithm', 'AWS4-HMAC-SHA256'],
      ['X-Amz-Credential', `${accessKeyId}/${credentialScope}`],
      ['X-Amz-Date', datetime],
      ['X-Amz-Expires', String(expiresInSeconds)],
      ['X-Amz-SignedHeaders', 'host'],
    ] as [string, string][]
  ).sort(([a], [b]) => (a < b ? -1 : 1));

  const canonicalQuery = queryParams
    .map(([k, v]) => `${encodeURIComponent(k)}=${encodeURIComponent(v)}`)
    .join('&');

  const canonicalRequest = [
    'GET',
    canonicalUri,
    canonicalQuery,
    `host:${host}\n`, // canonical headers section (must end with \n)
    'host',           // signed headers list
    'UNSIGNED-PAYLOAD',
  ].join('\n');

  const stringToSign = [
    'AWS4-HMAC-SHA256',
    datetime,
    credentialScope,
    await sha256Hex(canonicalRequest),
  ].join('\n');

  // Derive the signing key via an HMAC chain.
  const enc = new TextEncoder();
  const kDate = await hmacSha256(enc.encode(`AWS4${secretAccessKey}`).buffer as ArrayBuffer, date);
  const kRegion = await hmacSha256(kDate, region);
  const kService = await hmacSha256(kRegion, service);
  const kSigning = await hmacSha256(kService, 'aws4_request');
  const signature = toHex(await hmacSha256(kSigning, stringToSign));

  // Append the signature and produce the final URL.
  const finalQuery = [...queryParams, ['X-Amz-Signature', signature] as [string, string]]
    .sort(([a], [b]) => (a < b ? -1 : 1))
    .map(([k, v]) => `${encodeURIComponent(k)}=${encodeURIComponent(v)}`)
    .join('&');

  return `https://${host}${canonicalUri}?${finalQuery}`;
}
