import { describe, expect, it } from 'vitest';
import {
  MAX_CHUNK_BYTES,
  MAX_CHUNK_COUNT,
  MAX_VIDEO_BYTES,
  parseChunkMetadataFromFormData,
  validateChunkShape,
  validateInitialFile,
  validateMagicBytes,
} from './upload-validation';

describe('validateInitialFile', () => {
  it('accepts a normal mp4', () => {
    expect(
      validateInitialFile({ fileName: 'clip.mp4', mimeType: 'video/mp4', totalSize: 1024 }),
    ).toBeNull();
  });

  it('rejects non-video mime types', () => {
    const result = validateInitialFile({ fileName: 'clip.mp4', mimeType: 'image/png' });
    expect(result?.code).toBe('mime_not_allowed');
  });

  it('rejects mismatched extension', () => {
    const result = validateInitialFile({ fileName: 'clip.exe', mimeType: 'video/mp4' });
    expect(result?.code).toBe('extension_not_allowed');
  });

  it('accepts application/octet-stream when extension is valid', () => {
    expect(
      validateInitialFile({ fileName: 'clip.mp4', mimeType: 'application/octet-stream' }),
    ).toBeNull();
  });

  it('accepts an empty MIME type when extension is valid', () => {
    expect(validateInitialFile({ fileName: 'clip.mov', mimeType: '' })).toBeNull();
  });

  it('accepts arbitrary video/* MIME with valid extension', () => {
    expect(
      validateInitialFile({ fileName: 'clip.mp4', mimeType: 'video/x-some-codec' }),
    ).toBeNull();
  });

  it('accepts common video formats by extension', () => {
    const cases: Array<[string, string]> = [
      ['clip.mp4', 'video/mp4'],
      ['clip.m4v', 'video/x-m4v'],
      ['clip.mov', 'video/quicktime'],
      ['clip.mkv', 'video/x-matroska'],
      ['clip.webm', 'video/webm'],
    ];
    for (const [fileName, mimeType] of cases) {
      expect(validateInitialFile({ fileName, mimeType })).toBeNull();
    }
  });

  it('rejects formats removed from the allowlist (avi, flv, 3gp, ts, mpeg)', () => {
    const rejected = ['clip.avi', 'clip.flv', 'clip.3gp', 'clip.ts', 'clip.mpeg', 'clip.mpg', 'clip.ogv'];
    for (const fileName of rejected) {
      expect(validateInitialFile({ fileName, mimeType: 'video/mp4' })?.code).toBe('extension_not_allowed');
    }
  });

  it('rejects oversized files', () => {
    const result = validateInitialFile({
      fileName: 'big.mp4',
      mimeType: 'video/mp4',
      totalSize: MAX_VIDEO_BYTES + 1,
    });
    expect(result?.code).toBe('file_too_large');
  });

  it('accepts mkv, mov, webm', () => {
    expect(
      validateInitialFile({ fileName: 'a.mkv', mimeType: 'video/x-matroska' }),
    ).toBeNull();
    expect(validateInitialFile({ fileName: 'b.mov', mimeType: 'video/quicktime' })).toBeNull();
    expect(validateInitialFile({ fileName: 'c.webm', mimeType: 'video/webm' })).toBeNull();
  });
});

describe('validateChunkShape', () => {
  it('accepts a valid chunk', () => {
    expect(
      validateChunkShape({ chunkSize: 1024, chunkIndex: 0, chunkCount: 1 }),
    ).toBeNull();
  });

  it('rejects empty chunk', () => {
    expect(
      validateChunkShape({ chunkSize: 0, chunkIndex: 0, chunkCount: 1 })?.code,
    ).toBe('empty_file');
  });

  it('rejects oversized chunk', () => {
    expect(
      validateChunkShape({
        chunkSize: MAX_CHUNK_BYTES + 1,
        chunkIndex: 0,
        chunkCount: 1,
      })?.code,
    ).toBe('chunk_too_large');
  });

  it('rejects chunkCount over the cap', () => {
    expect(
      validateChunkShape({
        chunkSize: 1024,
        chunkIndex: 0,
        chunkCount: MAX_CHUNK_COUNT + 1,
      })?.code,
    ).toBe('chunk_count_invalid');
  });

  it('rejects chunkIndex out of range', () => {
    expect(
      validateChunkShape({ chunkSize: 1024, chunkIndex: 5, chunkCount: 3 })?.code,
    ).toBe('chunk_index_out_of_range');
  });
});

describe('parseChunkMetadataFromFormData', () => {
  // Regression: FormData.get returns null for absent keys; zod's .optional()
  // only accepts undefined, so a missing uploadId used to 400 every
  // single-chunk upload (the frontend never sets uploadId on chunk 0).
  it('accepts a single-chunk form with no uploadId field', () => {
    const fd = new FormData();
    fd.set('chunkIndex', '0');
    fd.set('chunkCount', '1');

    const result = parseChunkMetadataFromFormData(fd);

    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.uploadId).toBeUndefined();
      expect(result.data.chunkIndex).toBe(0);
      expect(result.data.chunkCount).toBe(1);
    }
  });

  it('accepts an empty form (defaults to single-chunk)', () => {
    const result = parseChunkMetadataFromFormData(new FormData());

    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.chunkIndex).toBe(0);
      expect(result.data.chunkCount).toBe(1);
    }
  });

  it('preserves an explicit uploadId', () => {
    const fd = new FormData();
    fd.set('uploadId', 'abc-123');
    fd.set('chunkIndex', '2');
    fd.set('chunkCount', '5');

    const result = parseChunkMetadataFromFormData(fd);

    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.uploadId).toBe('abc-123');
      expect(result.data.chunkIndex).toBe(2);
      expect(result.data.chunkCount).toBe(5);
    }
  });

  it('rejects a negative chunkIndex', () => {
    const fd = new FormData();
    fd.set('chunkIndex', '-1');
    fd.set('chunkCount', '1');

    expect(parseChunkMetadataFromFormData(fd).success).toBe(false);
  });

  it('rejects a non-positive chunkCount', () => {
    const fd = new FormData();
    fd.set('chunkIndex', '0');
    fd.set('chunkCount', '0');

    expect(parseChunkMetadataFromFormData(fd).success).toBe(false);
  });

  it('accepts a UUID-format uploadId', () => {
    const fd = new FormData();
    fd.set('uploadId', '550e8400-e29b-41d4-a716-446655440000');
    fd.set('chunkIndex', '1');
    fd.set('chunkCount', '3');

    const result = parseChunkMetadataFromFormData(fd);
    expect(result.success).toBe(true);
  });

  it('rejects an uploadId with path-traversal characters', () => {
    const badIds = ['../escape', 'has space', 'has/slash', '<script>', 'id;rm'];
    for (const id of badIds) {
      const fd = new FormData();
      fd.set('uploadId', id);
      fd.set('chunkIndex', '1');
      fd.set('chunkCount', '2');
      expect(parseChunkMetadataFromFormData(fd).success, `expected false for uploadId="${id}"`).toBe(false);
    }
  });

  it('rejects an uploadId longer than 64 characters', () => {
    const fd = new FormData();
    fd.set('uploadId', 'a'.repeat(65));
    fd.set('chunkIndex', '1');
    fd.set('chunkCount', '2');
    expect(parseChunkMetadataFromFormData(fd).success).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Magic-byte helpers
// ---------------------------------------------------------------------------

function makeEbml(): Uint8Array {
  // Minimal EBML header: 1A 45 DF A3 followed by padding
  return new Uint8Array([0x1a, 0x45, 0xdf, 0xa3, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00]);
}

function makeFtyp(brand: string): Uint8Array {
  // [size=24][ftyp][brand][version=0][compatible=brand]
  const bytes = new Uint8Array(24);
  bytes[3] = 24; // box size
  bytes[4] = 0x66; bytes[5] = 0x74; bytes[6] = 0x79; bytes[7] = 0x70; // 'ftyp'
  for (let i = 0; i < 4; i++) bytes[8 + i] = brand.charCodeAt(i); // major brand
  return bytes;
}

describe('validateMagicBytes', () => {
  it('accepts a WebM/MKV EBML header', () => {
    expect(validateMagicBytes(makeEbml())).toBeNull();
  });

  it('accepts common MP4 ftyp brands', () => {
    const brands = ['isom', 'iso2', 'avc1', 'mp41', 'hvc1', 'hev1', 'av01', 'M4V ', 'qt  ', 'f4v '];
    for (const brand of brands) {
      expect(validateMagicBytes(makeFtyp(brand))).toBeNull();
    }
  });

  it('rejects an unknown ftyp brand', () => {
    const result = validateMagicBytes(makeFtyp('heic'));
    expect(result?.code).toBe('codec_not_allowed');
  });

  it('rejects an unknown ftyp brand for an image container (avif)', () => {
    const result = validateMagicBytes(makeFtyp('avif'));
    expect(result?.code).toBe('codec_not_allowed');
  });

  it('rejects a file with no recognised magic bytes (e.g. a JPEG)', () => {
    const jpeg = new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10, 0x4a, 0x46, 0x49, 0x46, 0x00, 0x01]);
    expect(validateMagicBytes(jpeg)?.code).toBe('magic_bytes_invalid');
  });

  it('rejects a zeroed buffer (no container)', () => {
    expect(validateMagicBytes(new Uint8Array(12))?.code).toBe('magic_bytes_invalid');
  });

  it('rejects fewer than 4 bytes', () => {
    expect(validateMagicBytes(new Uint8Array([0x00, 0x00]))?.code).toBe('magic_bytes_invalid');
  });

  it('accepts a buffer with valid EBML but fewer than 12 bytes', () => {
    // Only 4 bytes — enough for EBML detection, brand read is not needed
    expect(validateMagicBytes(new Uint8Array([0x1a, 0x45, 0xdf, 0xa3]))).toBeNull();
  });

  it('accepts a ftyp file with fewer than 12 bytes (cannot read brand → pass through)', () => {
    // 8 bytes: size + 'ftyp' but no brand bytes
    const bytes = new Uint8Array([0x00, 0x00, 0x00, 0x18, 0x66, 0x74, 0x79, 0x70]);
    expect(validateMagicBytes(bytes)).toBeNull();
  });
});
