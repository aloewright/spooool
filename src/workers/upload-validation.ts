import { z } from 'zod';

// Cloudflare Stream accepts every format we list (and more); the gating signal
// is the file extension, not the MIME — browsers report inconsistent MIME types
// for the same file (e.g. .mov as video/quicktime on Safari, video/mp4 on some
// versions of Chrome, application/octet-stream when the OS has no handler).
export const ALLOWED_VIDEO_MIME_TYPES = new Set<string>([
  'video/mp4',
  'video/webm',
  'video/quicktime',
  'video/x-matroska',
  'video/x-msvideo',
  'video/avi',
  'video/mpeg',
  'video/x-m4v',
  'video/3gpp',
  'video/3gpp2',
  'video/ogg',
  'video/x-flv',
  'video/mp2t',
]);

// 30GB matches Cloudflare Stream's basic-ingest ceiling — videos larger than
// this transcode-fail downstream, so the upload gate enforces the same limit.
export const MAX_VIDEO_BYTES = 30 * 1024 * 1024 * 1024;
export const MAX_CHUNK_BYTES = 50 * 1024 * 1024;
// R2 multipart caps at 10,000 parts. Frontend uses 10MB chunks
// (CHUNK_SIZE in Upload.tsx), so 30GB / 10MB = 3,072 parts — well under.
// Keep this calculation in sync with CHUNK_SIZE on the frontend.
export const MAX_CHUNK_COUNT = Math.ceil(MAX_VIDEO_BYTES / (10 * 1024 * 1024));

const ALLOWED_EXTENSIONS = new Set<string>([
  'mp4',
  'm4v',
  'webm',
  'mov',
  'mkv',
  'avi',
  'mpeg',
  'mpg',
  'ogv',
  '3gp',
  'flv',
  'ts',
]);

export type UploadValidationError = {
  code:
    | 'mime_not_allowed'
    | 'extension_not_allowed'
    | 'file_too_large'
    | 'chunk_too_large'
    | 'chunk_count_invalid'
    | 'chunk_index_out_of_range'
    | 'empty_file'
    | 'magic_bytes_unrecognized'
    | 'magic_bytes_mismatch'
    | 'magic_bytes_brand_unsupported';
  message: string;
};

// 32 bytes is enough to read the first ISO BMFF box header (4 size + 4 'ftyp'
// + 4 major brand + 4 minor + at least one compatible brand). EBML/RIFF/Ogg/FLV
// signatures all fit comfortably in 12 bytes. We over-read slightly so future
// brand checks have room without changing the slice on the upload path.
export const MAGIC_HEADER_BYTES = 32;

function fileExtension(name: string): string {
  const dot = name.lastIndexOf('.');
  if (dot < 0 || dot === name.length - 1) {
    return '';
  }
  return name.slice(dot + 1).toLowerCase();
}

export function validateChunkShape(params: {
  chunkSize: number;
  chunkIndex: number;
  chunkCount: number;
}): UploadValidationError | null {
  if (params.chunkSize <= 0) {
    return { code: 'empty_file', message: 'Chunk is empty' };
  }
  if (params.chunkSize > MAX_CHUNK_BYTES) {
    return {
      code: 'chunk_too_large',
      message: `Chunk exceeds ${MAX_CHUNK_BYTES} bytes`,
    };
  }
  if (params.chunkCount < 1 || params.chunkCount > MAX_CHUNK_COUNT) {
    return {
      code: 'chunk_count_invalid',
      message: `chunkCount must be between 1 and ${MAX_CHUNK_COUNT}`,
    };
  }
  if (params.chunkIndex < 0 || params.chunkIndex >= params.chunkCount) {
    return {
      code: 'chunk_index_out_of_range',
      message: 'chunkIndex is out of range for chunkCount',
    };
  }
  return null;
}

const chunkMetadataSchema = z.object({
  uploadId: z.string().optional(),
  chunkIndex: z.coerce.number().int().min(0).default(0),
  chunkCount: z.coerce.number().int().positive().default(1),
});

export type ChunkMetadata = z.infer<typeof chunkMetadataSchema>;

export type ChunkMetadataParseResult =
  | { success: true; data: ChunkMetadata }
  | { success: false; error: z.ZodError };

// FormData.get returns `null` for missing keys; zod's .optional() only accepts
// `undefined`. This wrapper bridges that gap so single-chunk uploads (which
// omit uploadId) parse correctly. Regression coverage in upload-validation.test.ts.
export function parseChunkMetadataFromFormData(formData: FormData): ChunkMetadataParseResult {
  const result = chunkMetadataSchema.safeParse({
    uploadId: formData.get('uploadId') ?? undefined,
    chunkIndex: formData.get('chunkIndex') ?? '0',
    chunkCount: formData.get('chunkCount') ?? '1',
  });
  return result.success
    ? { success: true, data: result.data }
    : { success: false, error: result.error };
}

function isAcceptableMime(mime: string): boolean {
  if (!mime) return true; // Browser couldn't detect — defer to extension check.
  if (ALLOWED_VIDEO_MIME_TYPES.has(mime)) return true;
  if (mime.startsWith('video/')) return true;
  // Browsers report this for files the OS has no handler for (common with .mkv,
  // .ts, less common containers). Stream validates the actual bytes anyway.
  if (mime === 'application/octet-stream') return true;
  return false;
}

export function validateInitialFile(params: {
  fileName: string;
  mimeType: string;
  totalSize?: number;
}): UploadValidationError | null {
  const ext = fileExtension(params.fileName);
  if (!ALLOWED_EXTENSIONS.has(ext)) {
    return {
      code: 'extension_not_allowed',
      message: `Unsupported file extension: .${ext || 'unknown'}`,
    };
  }
  if (!isAcceptableMime(params.mimeType)) {
    return {
      code: 'mime_not_allowed',
      message: `Unsupported MIME type: ${params.mimeType || 'unknown'}`,
    };
  }
  if (typeof params.totalSize === 'number' && params.totalSize > MAX_VIDEO_BYTES) {
    return {
      code: 'file_too_large',
      message: `File exceeds ${MAX_VIDEO_BYTES} bytes`,
    };
  }
  return null;
}

// ALO-140: detected container categories. EBML (webm/mkv) shares one signature
// since the DocType lives further into the stream than our 32-byte header read.
// Both are accepted, and the file extension disambiguates the user's intent.
export type DetectedContainer =
  | 'mp4'
  | 'mov'
  | '3gp'
  | 'webm-or-mkv'
  | 'avi'
  | 'mpeg'
  | 'mpeg-ts'
  | 'ogg'
  | 'flv';

// ISO BMFF major brands we accept. The brand also implies a sane codec — e.g.
// 'avc1' → H.264, 'av01' → AV1, 'hev1'/'hvc1' → HEVC. Anything outside this
// list (proprietary brands like 'jpm ', encrypted-only brands, etc.) is
// rejected so we don't pay for a Stream transcode that will fail.
const ISO_BMFF_MP4_BRANDS = new Set<string>([
  'isom', 'iso2', 'iso4', 'iso5', 'iso6', 'iso7', 'iso8', 'iso9',
  'mp41', 'mp42', 'mp4v', 'mp71', 'MSNV', 'msnv', 'NDXC', 'NDXM', 'NDSC',
  'avc1', 'av01', 'hev1', 'hvc1', 'dby1', 'dash', 'dsms', 'msdh', 'msix',
  'mmp4', 'M4V ', 'M4A ', 'M4P ', 'M4B ',
]);
const ISO_BMFF_MOV_BRANDS = new Set<string>(['qt  ']);
const ISO_BMFF_3GP_BRANDS = new Set<string>([
  '3gp4', '3gp5', '3gp6', '3gp7', '3gp8', '3g2a', '3g2b', '3g2c',
]);

const EXT_TO_CONTAINERS: Record<string, ReadonlySet<DetectedContainer>> = {
  mp4: new Set(['mp4']),
  m4v: new Set(['mp4']),
  // Some QuickTime files are written with mp4 brands, and some "mp4" files use
  // 'qt  '. Accepting either keeps Safari exports working without weakening
  // the guard against non-video uploads.
  mov: new Set(['mov', 'mp4']),
  webm: new Set(['webm-or-mkv']),
  mkv: new Set(['webm-or-mkv']),
  avi: new Set(['avi']),
  mpeg: new Set(['mpeg', 'mpeg-ts']),
  mpg: new Set(['mpeg', 'mpeg-ts']),
  ogv: new Set(['ogg']),
  '3gp': new Set(['3gp', 'mp4']),
  flv: new Set(['flv']),
  ts: new Set(['mpeg-ts']),
};

function readBrand(bytes: Uint8Array, offset: number): string {
  return String.fromCharCode(bytes[offset], bytes[offset + 1], bytes[offset + 2], bytes[offset + 3]);
}

export type SniffResult = {
  container: DetectedContainer | null;
  brand?: string;
  brandRecognized?: boolean;
};

// Inspect the first bytes of a video file and identify the container by its
// magic signature. Returning {container: null} means we couldn't recognize
// the bytes as any supported video container — likely not a video at all,
// or a malformed/truncated header.
export function sniffContainer(bytes: Uint8Array): SniffResult {
  // ISO BMFF: bytes 4-7 spell 'ftyp'. Major brand is at 8-11.
  if (
    bytes.length >= 12 &&
    bytes[4] === 0x66 && bytes[5] === 0x74 && bytes[6] === 0x79 && bytes[7] === 0x70
  ) {
    const brand = readBrand(bytes, 8);
    if (ISO_BMFF_MOV_BRANDS.has(brand)) {
      return { container: 'mov', brand, brandRecognized: true };
    }
    if (ISO_BMFF_3GP_BRANDS.has(brand)) {
      return { container: '3gp', brand, brandRecognized: true };
    }
    if (ISO_BMFF_MP4_BRANDS.has(brand)) {
      return { container: 'mp4', brand, brandRecognized: true };
    }
    return { container: null, brand, brandRecognized: false };
  }
  // EBML: 0x1A 0x45 0xDF 0xA3 — both webm and mkv use this header.
  if (
    bytes.length >= 4 &&
    bytes[0] === 0x1a && bytes[1] === 0x45 && bytes[2] === 0xdf && bytes[3] === 0xa3
  ) {
    return { container: 'webm-or-mkv' };
  }
  // RIFF AVI: 'RIFF' + 4-byte size + 'AVI '.
  if (
    bytes.length >= 12 &&
    bytes[0] === 0x52 && bytes[1] === 0x49 && bytes[2] === 0x46 && bytes[3] === 0x46 &&
    bytes[8] === 0x41 && bytes[9] === 0x56 && bytes[10] === 0x49 && bytes[11] === 0x20
  ) {
    return { container: 'avi' };
  }
  // MPEG program/elementary stream start codes.
  if (
    bytes.length >= 4 &&
    bytes[0] === 0x00 && bytes[1] === 0x00 && bytes[2] === 0x01 &&
    (bytes[3] === 0xba || bytes[3] === 0xb3)
  ) {
    return { container: 'mpeg' };
  }
  // Ogg: 'OggS' capture pattern.
  if (
    bytes.length >= 4 &&
    bytes[0] === 0x4f && bytes[1] === 0x67 && bytes[2] === 0x67 && bytes[3] === 0x53
  ) {
    return { container: 'ogg' };
  }
  // FLV: 'FLV' + version byte (typically 0x01).
  if (
    bytes.length >= 4 &&
    bytes[0] === 0x46 && bytes[1] === 0x4c && bytes[2] === 0x56 &&
    bytes[3] <= 0x0f
  ) {
    return { container: 'flv' };
  }
  // MPEG-TS: 0x47 sync byte at offset 0 AND offset 188. Checking the second
  // sync byte avoids false positives from any random 0x47 first byte.
  if (bytes.length >= 1 && bytes[0] === 0x47) {
    // 32-byte header isn't enough to see the second sync byte at 188; accept
    // it as MPEG-TS but only when the extension also says so. The mismatch
    // check downstream handles the sanity gate.
    return { container: 'mpeg-ts' };
  }
  return { container: null };
}

export function validateMagicBytes(params: {
  fileName: string;
  headerBytes: Uint8Array;
}): UploadValidationError | null {
  const sniff = sniffContainer(params.headerBytes);
  const ext = fileExtension(params.fileName);

  if (sniff.brandRecognized === false) {
    return {
      code: 'magic_bytes_brand_unsupported',
      message: `ISO BMFF brand '${sniff.brand ?? '????'}' is not on the supported codec list`,
    };
  }
  if (!sniff.container) {
    return {
      code: 'magic_bytes_unrecognized',
      message: 'File header does not match any supported video container',
    };
  }

  const expected = EXT_TO_CONTAINERS[ext];
  if (!expected) {
    // The extension was already rejected by validateInitialFile; treat the
    // absence of a rule as "no extra constraint" rather than re-reporting it
    // here, so the more specific error wins.
    return null;
  }
  if (!expected.has(sniff.container)) {
    return {
      code: 'magic_bytes_mismatch',
      message: `File extension .${ext} does not match detected container (${sniff.container})`,
    };
  }
  return null;
}
