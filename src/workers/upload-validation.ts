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
  'video/x-m4v',
]);

// 30GB matches Cloudflare Stream's basic-ingest ceiling — videos larger than
// this transcode-fail downstream, so the upload gate enforces the same limit.
export const MAX_VIDEO_BYTES = 30 * 1024 * 1024 * 1024;
export const MAX_CHUNK_BYTES = 50 * 1024 * 1024;
// R2 multipart caps at 10,000 parts. Frontend uses 10MB chunks
// (CHUNK_SIZE in Upload.tsx), so 30GB / 10MB = 3,072 parts — well under.
// Keep this calculation in sync with CHUNK_SIZE on the frontend.
export const MAX_CHUNK_COUNT = Math.ceil(MAX_VIDEO_BYTES / (10 * 1024 * 1024));

// Restricted to containers we can reliably identify by magic bytes and that
// our encoding pipeline handles well. Exotic formats (AVI, FLV, MPEG-TS, 3GP)
// are excluded — they reach us rarely and add encoder edge cases.
const ALLOWED_EXTENSIONS = new Set<string>(['mp4', 'm4v', 'webm', 'mov', 'mkv']);

// ftyp major brands (bytes 8–11 of an ISO Base Media file) that indicate a
// codec family we support. This is not a full codec parse — the moov box is
// not in chunk 0 for large files — but the brand is a reliable proxy:
//   isom/iso2–9 → generic MPEG-4 (almost always H.264 in practice)
//   avc1/avc2/avc3 → H.264 explicitly
//   hvc1/hev1 → H.265 / HEVC
//   av01 → AV1
//   mp41/mp42 → MPEG-4 v1/v2
//   M4V /M4VP/M4VH → iTunes video
//   qt   → QuickTime (.mov)
//   f4v  → Flash Video in ISOBMFF wrapper (widely used legacy)
//   dash/cmfc → MPEG-DASH fragmented
//   mmp4/MSNV → mobile MP4 variants
const ALLOWED_FTYP_BRANDS = new Set<string>([
  'isom', 'iso2', 'iso3', 'iso4', 'iso5', 'iso6', 'iso7', 'iso8', 'iso9',
  'avc1', 'avc2', 'avc3',
  'hvc1', 'hev1',
  'av01',
  'mp41', 'mp42',
  'M4V ', 'M4VP', 'M4VH', 'M4A ',
  'qt  ',
  'f4v ',
  'dash', 'cmfc',
  'mmp4', 'MSNV',
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
    | 'magic_bytes_invalid'
    | 'codec_not_allowed';
  message: string;
};

// ---------------------------------------------------------------------------
// Magic-bytes helpers
// ---------------------------------------------------------------------------

// EBML element ID that heads every WebM and MKV file: 1A 45 DF A3
const EBML_MAGIC = [0x1a, 0x45, 0xdf, 0xa3] as const;

type ContainerHint = 'ebml' | 'ftyp' | null;

function sniffContainer(bytes: Uint8Array): ContainerHint {
  if (bytes.length < 4) return null;
  if (
    bytes[0] === EBML_MAGIC[0] &&
    bytes[1] === EBML_MAGIC[1] &&
    bytes[2] === EBML_MAGIC[2] &&
    bytes[3] === EBML_MAGIC[3]
  ) {
    return 'ebml';
  }
  // ftyp box layout: [4-byte size][4-byte 'ftyp'][4-byte major brand]...
  // The box type lives at byte offset 4 regardless of the size field value.
  if (
    bytes.length >= 8 &&
    bytes[4] === 0x66 && // 'f'
    bytes[5] === 0x74 && // 't'
    bytes[6] === 0x79 && // 'y'
    bytes[7] === 0x70    // 'p'
  ) {
    return 'ftyp';
  }
  return null;
}

function readFtypBrand(bytes: Uint8Array): string {
  if (bytes.length < 12) return '';
  // Major brand is the 4 ASCII bytes immediately after the 'ftyp' marker.
  return String.fromCharCode(bytes[8], bytes[9], bytes[10], bytes[11]);
}

/**
 * Inspect the first bytes of chunk 0 and reject files that don't begin with
 * a recognised container signature or that carry a disallowed codec brand.
 *
 * Call this only on chunkIndex === 0 after validateInitialFile passes.
 * Pass at least 12 bytes so ftyp brand extraction is possible.
 */
export function validateMagicBytes(bytes: Uint8Array): UploadValidationError | null {
  const container = sniffContainer(bytes);

  if (container === null) {
    return {
      code: 'magic_bytes_invalid',
      message: 'File does not begin with a recognised video container signature (expected MP4/MOV ftyp box or WebM/MKV EBML header)',
    };
  }

  if (container === 'ftyp') {
    const brand = readFtypBrand(bytes);
    if (brand && !ALLOWED_FTYP_BRANDS.has(brand)) {
      return {
        code: 'codec_not_allowed',
        message: `Unsupported codec or container brand: "${brand}". Accepted formats: MP4 (H.264/H.265/AV1), MOV, WebM, MKV.`,
      };
    }
  }

  // EBML files (WebM/MKV): magic verified. The WebM spec restricts video to
  // VP8/VP9/AV1 by definition; MKV codec enforcement is left to the encoder.
  return null;
}

// ---------------------------------------------------------------------------

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
  uploadId: z.string().regex(/^[A-Za-z0-9_-]{1,64}$/).optional(),
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
