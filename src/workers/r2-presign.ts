// AWS4 HMAC-SHA256 presigned URL generator for Cloudflare R2 (S3-compatible).
//
// R2 endpoint: https://{accountId}.r2.cloudflarestorage.com/{bucket}/{key}
// Region is always "auto" for R2.
//
// Usage: redirect the client to the returned URL instead of proxying the body
// through the Worker. The client (browser / HLS player) fetches directly from
// R2, which handles Range requests natively — no proxy overhead for large files.

const ALGORITHM = 'AWS4-HMAC-SHA256';
const REGION = 'auto';
const SERVICE = 's3';

async function hmac(key: ArrayBuffer, data: string): Promise<ArrayBuffer> {
  const cryptoKey = await crypto.subtle.importKey(
    'raw',
    key,
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign'],
  );
  return crypto.subtle.sign('HMAC', cryptoKey, new TextEncoder().encode(data));
}

async function sha256hex(data: string): Promise<string> {
  const buf = await crypto.subtle.digest(
    'SHA-256',
    new TextEncoder().encode(data),
  );
  return toHex(buf);
}

function toHex(buf: ArrayBuffer): string {
  return Array.from(new Uint8Array(buf))
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('');
}

export interface R2PresignOptions {
  accountId: string;
  bucketName: string;
  key: string;
  accessKeyId: string;
  secretAccessKey: string;
  /** Lifetime of the presigned URL in seconds (max 604800 = 7 days). */
  expiresIn: number;
  /** Current time — caller-supplied so tests can fix the clock. */
  now: Date;
}

export async function generateR2PresignedUrl(opts: R2PresignOptions): Promise<string> {
  const { accountId, bucketName, key, accessKeyId, secretAccessKey, expiresIn, now } = opts;

  const host = `${accountId}.r2.cloudflarestorage.com`;

  // Compact ISO-8601 timestamps required by AWS4.
  const dateTime = now.toISOString().replace(/[:-]/g, '').replace(/\.\d{3}Z$/, 'Z');
  const dateOnly = dateTime.slice(0, 8); // YYYYMMDD

  const credentialScope = `${dateOnly}/${REGION}/${SERVICE}/aws4_request`;
  const credential = `${accessKeyId}/${credentialScope}`;

  // Query parameters must be sorted and percent-encoded per the AWS spec.
  // We build them sorted lexicographically by key name.
  const queryParams: [string, string][] = [
    ['X-Amz-Algorithm', ALGORITHM],
    ['X-Amz-Credential', credential],
    ['X-Amz-Date', dateTime],
    ['X-Amz-Expires', String(expiresIn)],
    ['X-Amz-SignedHeaders', 'host'],
  ];
  queryParams.sort(([a], [b]) => a.localeCompare(b));

  const canonicalQueryString = queryParams
    .map(([k, v]) => `${encodeURIComponent(k)}=${encodeURIComponent(v)}`)
    .join('&');

  // Encode the path. Each segment of the key is percent-encoded independently.
  const encodedKey = key
    .split('/')
    .map((seg) => encodeURIComponent(seg))
    .join('/');
  const canonicalUri = `/${bucketName}/${encodedKey}`;

  const canonicalHeaders = `host:${host}\n`;
  const signedHeaders = 'host';

  const canonicalRequest = [
    'GET',
    canonicalUri,
    canonicalQueryString,
    canonicalHeaders,
    signedHeaders,
    'UNSIGNED-PAYLOAD',
  ].join('\n');

  const requestHash = await sha256hex(canonicalRequest);
  const stringToSign = [ALGORITHM, dateTime, credentialScope, requestHash].join('\n');

  // Derive the signing key: HMAC(HMAC(HMAC(HMAC("AWS4"+secret, date), region), service), "aws4_request")
  const kDate = await hmac(new TextEncoder().encode(`AWS4${secretAccessKey}`), dateOnly);
  const kRegion = await hmac(kDate, REGION);
  const kService = await hmac(kRegion, SERVICE);
  const kSigning = await hmac(kService, 'aws4_request');

  const signature = toHex(await hmac(kSigning, stringToSign));

  const finalQuery =
    queryParams
      .map(([k, v]) => `${encodeURIComponent(k)}=${encodeURIComponent(v)}`)
      .join('&') + `&X-Amz-Signature=${signature}`;

  return `https://${host}${canonicalUri}?${finalQuery}`;
}
