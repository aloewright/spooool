import { describe, expect, it } from 'vitest';
import {
  MAX_CHUNK_BYTES,
  MAX_CHUNK_COUNT,
  MAX_VIDEO_BYTES,
  parseChunkMetadataFromFormData,
  sniffContainer,
  validateChunkShape,
  validateInitialFile,
  validateMagicBytes,
} from './upload-validation';

function ascii(text: string): number[] {
  const out = new Array<number>(text.length);
  for (let i = 0; i < text.length; i += 1) out[i] = text.charCodeAt(i);
  return out;
}

function isoBmffHeader(brand: string, compat: string[] = []): Uint8Array {
  // Box layout: [4-byte size][4-byte 'ftyp'][4-byte major brand][4-byte minor]
  // followed by compatible-brands (4 bytes each). Size doesn't matter for sniff.
  const bytes: number[] = [
    0x00, 0x00, 0x00, 0x20, // size
    ...ascii('ftyp'),
    ...ascii(brand.padEnd(4, ' ').slice(0, 4)),
    0x00, 0x00, 0x00, 0x00, // minor version
  ];
  for (const c of compat) bytes.push(...ascii(c.padEnd(4, ' ').slice(0, 4)));
  while (bytes.length < 32) bytes.push(0x00);
  return Uint8Array.from(bytes);
}

function ebmlHeader(): Uint8Array {
  // EBML magic + arbitrary tail bytes that the sniffer should ignore.
  return Uint8Array.from([0x1a, 0x45, 0xdf, 0xa3, 0x9f, 0x42, 0x86, 0x81, 0x01]);
}

function aviHeader(): Uint8Array {
  return Uint8Array.from([
    ...ascii('RIFF'),
    0x24, 0x00, 0x00, 0x00,
    ...ascii('AVI '),
  ]);
}

function flvHeader(): Uint8Array {
  return Uint8Array.from([...ascii('FLV'), 0x01, 0x05, 0x00, 0x00, 0x00, 0x09]);
}

function oggHeader(): Uint8Array {
  return Uint8Array.from([...ascii('OggS'), 0x00, 0x02]);
}

function mpegPsHeader(): Uint8Array {
  return Uint8Array.from([0x00, 0x00, 0x01, 0xba, 0x44, 0x00]);
}

function mpegTsHeader(): Uint8Array {
  return Uint8Array.from([0x47, 0x40, 0x00, 0x10]);
}

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
      ['clip.avi', 'video/x-msvideo'],
      ['clip.mpeg', 'video/mpeg'],
      ['clip.mpg', 'video/mpeg'],
      ['clip.3gp', 'video/3gpp'],
      ['clip.ogv', 'video/ogg'],
      ['clip.flv', 'video/x-flv'],
      ['clip.ts', 'video/mp2t'],
    ];
    for (const [fileName, mimeType] of cases) {
      expect(validateInitialFile({ fileName, mimeType })).toBeNull();
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
});

describe('sniffContainer', () => {
  it('detects an mp4 (isom) header', () => {
    const result = sniffContainer(isoBmffHeader('isom', ['mp42', 'avc1']));
    expect(result.container).toBe('mp4');
    expect(result.brand).toBe('isom');
    expect(result.brandRecognized).toBe(true);
  });

  it('detects an mp4 with mp42 brand', () => {
    const result = sniffContainer(isoBmffHeader('mp42'));
    expect(result.container).toBe('mp4');
  });

  it('detects an mp4 with avc1 brand', () => {
    const result = sniffContainer(isoBmffHeader('avc1'));
    expect(result.container).toBe('mp4');
  });

  it('detects a quicktime mov header', () => {
    const result = sniffContainer(isoBmffHeader('qt  '));
    expect(result.container).toBe('mov');
  });

  it('detects a 3gp header', () => {
    const result = sniffContainer(isoBmffHeader('3gp4'));
    expect(result.container).toBe('3gp');
  });

  it('flags an unsupported ISO BMFF brand', () => {
    const result = sniffContainer(isoBmffHeader('jpm '));
    expect(result.container).toBeNull();
    expect(result.brand).toBe('jpm ');
    expect(result.brandRecognized).toBe(false);
  });

  it('detects a webm/mkv EBML header', () => {
    expect(sniffContainer(ebmlHeader()).container).toBe('webm-or-mkv');
  });

  it('detects an avi RIFF header', () => {
    expect(sniffContainer(aviHeader()).container).toBe('avi');
  });

  it('detects an mpeg program-stream header', () => {
    expect(sniffContainer(mpegPsHeader()).container).toBe('mpeg');
  });

  it('detects an mpeg-ts sync byte', () => {
    expect(sniffContainer(mpegTsHeader()).container).toBe('mpeg-ts');
  });

  it('detects an Ogg header', () => {
    expect(sniffContainer(oggHeader()).container).toBe('ogg');
  });

  it('detects an FLV header', () => {
    expect(sniffContainer(flvHeader()).container).toBe('flv');
  });

  it('returns null for a PNG-shaped header', () => {
    const png = Uint8Array.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
    expect(sniffContainer(png).container).toBeNull();
  });

  it('returns null for too-short input', () => {
    expect(sniffContainer(Uint8Array.from([0x00, 0x01])).container).toBeNull();
  });
});

describe('validateMagicBytes', () => {
  it('accepts an mp4 file with matching mp4 header', () => {
    expect(
      validateMagicBytes({ fileName: 'clip.mp4', headerBytes: isoBmffHeader('isom') }),
    ).toBeNull();
  });

  it('accepts a webm file with EBML header', () => {
    expect(
      validateMagicBytes({ fileName: 'clip.webm', headerBytes: ebmlHeader() }),
    ).toBeNull();
  });

  it('accepts an mkv file with EBML header (same magic as webm)', () => {
    expect(
      validateMagicBytes({ fileName: 'clip.mkv', headerBytes: ebmlHeader() }),
    ).toBeNull();
  });

  it('accepts a mov file with quicktime brand', () => {
    expect(
      validateMagicBytes({ fileName: 'clip.mov', headerBytes: isoBmffHeader('qt  ') }),
    ).toBeNull();
  });

  // QuickTime exporters sometimes write .mov containers with mp4 brands. Both
  // play fine and Stream re-muxes them anyway.
  it('accepts a mov file with mp4-style brand', () => {
    expect(
      validateMagicBytes({ fileName: 'clip.mov', headerBytes: isoBmffHeader('mp42') }),
    ).toBeNull();
  });

  it('rejects an mp4 extension when the header is webm', () => {
    const result = validateMagicBytes({
      fileName: 'fake.mp4',
      headerBytes: ebmlHeader(),
    });
    expect(result?.code).toBe('magic_bytes_mismatch');
  });

  it('rejects a webm extension when the header is mp4', () => {
    const result = validateMagicBytes({
      fileName: 'fake.webm',
      headerBytes: isoBmffHeader('isom'),
    });
    expect(result?.code).toBe('magic_bytes_mismatch');
  });

  it('rejects a renamed image (PNG bytes with .mp4 extension)', () => {
    const png = Uint8Array.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 0]);
    const result = validateMagicBytes({ fileName: 'evil.mp4', headerBytes: png });
    expect(result?.code).toBe('magic_bytes_unrecognized');
  });

  it('rejects an ISO BMFF file with an unsupported brand', () => {
    const result = validateMagicBytes({
      fileName: 'weird.mp4',
      headerBytes: isoBmffHeader('jpm '),
    });
    expect(result?.code).toBe('magic_bytes_brand_unsupported');
  });

  it('accepts a ts file with mpeg-ts sync byte', () => {
    expect(
      validateMagicBytes({ fileName: 'clip.ts', headerBytes: mpegTsHeader() }),
    ).toBeNull();
  });

  it('accepts an avi file with RIFF header', () => {
    expect(
      validateMagicBytes({ fileName: 'clip.avi', headerBytes: aviHeader() }),
    ).toBeNull();
  });
});
