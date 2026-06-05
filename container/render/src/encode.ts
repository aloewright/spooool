// HLS transcoding for the R2+FFmpeg fallback encoding path (ALO-136).
// Downloads a raw video from R2, produces three adaptive-bitrate HLS variants
// via a single FFmpeg pass (decode once, encode 3x), uploads all segments and
// playlists under hls/{videoId}/ in R2, and returns the master playlist key.

import { spawn } from 'node:child_process';
import { mkdir, mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import { createWriteStream } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { pipeline } from 'node:stream/promises';
import { Readable } from 'node:stream';
import { GetObjectCommand, PutObjectCommand } from '@aws-sdk/client-s3';
import type { S3Client } from '@aws-sdk/client-s3';

const VARIANTS = [
  { label: '1080p', scale: 'scale=1920:-2', maxrate: '5000k', bufsize: '10000k', abr: '192k', bandwidth: 5192000, resolution: '1920x1080' },
  { label: '720p',  scale: 'scale=1280:-2', maxrate: '2500k', bufsize:  '5000k', abr: '128k', bandwidth: 2628000, resolution: '1280x720'  },
  { label: '360p',  scale: 'scale=640:-2',  maxrate:  '500k', bufsize:  '1000k', abr:  '96k', bandwidth:  596000, resolution:  '640x360'  },
] as const;

export type EncodeResult = {
  masterKey: string;
  thumbnailKey: string | null;
};

export async function encodeToHls(opts: {
  videoId: string;
  r2Key: string;
  s3: S3Client;
  bucket: string;
}): Promise<EncodeResult> {
  const { videoId, r2Key, s3, bucket } = opts;
  const workDir = await mkdtemp(join(tmpdir(), 'enc-'));
  const inputPath = join(workDir, 'input');
  const hlsDir = join(workDir, 'hls');
  await mkdir(hlsDir, { recursive: true });

  try {
    // 1. Stream raw video from R2 to disk
    const obj = await s3.send(new GetObjectCommand({ Bucket: bucket, Key: r2Key }));
    if (!obj.Body) throw new Error(`R2 object not found: ${r2Key}`);
    const nodeStream = Readable.fromWeb(
      obj.Body.transformToWebStream() as Parameters<typeof Readable.fromWeb>[0],
    );
    await pipeline(nodeStream, createWriteStream(inputPath));

    // 2. Single FFmpeg pass → 3 HLS variant playlists + segments
    await runFfmpeg(inputPath, hlsDir);

    // 3. Write master playlist (FFmpeg doesn't generate one for multi-output)
    await writeFile(join(hlsDir, 'master.m3u8'), buildMasterPlaylist());

    // 4. Upload all HLS files to R2
    const prefix = `hls/${videoId}`;
    await uploadDir(hlsDir, prefix, s3, bucket);

    // 5. Extract a thumbnail at 1s for the video card / watch page
    const thumbnailKey = await extractThumbnail({ inputPath, videoId, r2Key, s3, bucket }).catch(() => null);

    return { masterKey: `${prefix}/master.m3u8`, thumbnailKey };
  } finally {
    await rm(workDir, { recursive: true, force: true });
  }
}

async function extractThumbnail(opts: {
  inputPath: string;
  videoId: string;
  r2Key: string;
  s3: S3Client;
  bucket: string;
}): Promise<string> {
  const { inputPath, videoId, r2Key, s3, bucket } = opts;
  // r2Key format: "{userId}/{videoId}/{filename}" — extract userId from first segment.
  const userId = r2Key.split('/')[0];
  const thumbPath = `${inputPath}_thumb.jpg`;
  await new Promise<void>((resolve, reject) => {
    // Seek to 1s, extract a single frame, scale to 640px wide, quality 4 (~80%).
    // Stderr is suppressed; the caller treats errors as non-fatal.
    const proc = spawn('ffmpeg', [
      '-y', '-ss', '1', '-i', inputPath,
      '-frames:v', '1', '-vf', 'scale=640:-2',
      '-q:v', '4', thumbPath,
    ], { stdio: ['ignore', 'ignore', 'ignore'] });
    proc.on('error', reject);
    proc.on('close', (code) => {
      if (code !== 0) reject(new Error(`ffmpeg thumbnail exited ${code}`));
      else resolve();
    });
  });
  const body = await readFile(thumbPath);
  // Key matches the path expected by /api/thumbnails/:userId/:videoId/:objectName.
  const key = `thumbnails/${userId}/${videoId}/auto.jpg`;
  await s3.send(new PutObjectCommand({
    Bucket: bucket,
    Key: key,
    Body: body,
    ContentType: 'image/jpeg',
  }));
  return key;
}

function runFfmpeg(inputPath: string, hlsDir: string): Promise<void> {
  return new Promise((resolve, reject) => {
    // Split the video stream once and scale to each variant resolution.
    const n = VARIANTS.length;
    const splitLabel = VARIANTS.map((_, i) => `[v${i}]`).join('');
    const filterComplex = [
      `[0:v]split=${n}${splitLabel}`,
      ...VARIANTS.map((v, i) => `[v${i}]${v.scale}[s${i}]`),
    ].join(';');

    const args: string[] = ['-y', '-i', inputPath, '-filter_complex', filterComplex];

    for (let i = 0; i < VARIANTS.length; i++) {
      const v = VARIANTS[i];
      args.push(
        '-map', `[s${i}]`,
        '-map', '0:a?',                       // optional — skip if input has no audio
        '-c:v', 'libx264', '-preset', 'fast',
        '-maxrate', v.maxrate, '-bufsize', v.bufsize,
        '-c:a', 'aac', '-b:a', v.abr, '-ac', '2',
        '-f', 'hls',
        '-hls_time', '6',
        '-hls_playlist_type', 'vod',
        '-hls_flags', 'independent_segments',
        '-hls_segment_filename', join(hlsDir, `${v.label}_seg%03d.ts`),
        join(hlsDir, `${v.label}.m3u8`),
      );
    }

    let stderr = '';
    const proc = spawn('ffmpeg', args, { stdio: ['ignore', 'ignore', 'pipe'] });
    proc.stderr?.on('data', (d: Buffer) => { stderr += d.toString(); });
    proc.on('error', reject);
    proc.on('close', (code) => {
      if (code !== 0) {
        reject(new Error(`ffmpeg exited ${code}: ${stderr.slice(-2000)}`));
      } else {
        resolve();
      }
    });
  });
}

function buildMasterPlaylist(): string {
  const lines = ['#EXTM3U', '#EXT-X-VERSION:3'];
  for (const v of VARIANTS) {
    lines.push(`#EXT-X-STREAM-INF:BANDWIDTH=${v.bandwidth},RESOLUTION=${v.resolution}`);
    lines.push(`${v.label}.m3u8`);
  }
  return lines.join('\n') + '\n';
}

async function uploadDir(dir: string, prefix: string, s3: S3Client, bucket: string): Promise<void> {
  const entries = await readdir(dir, { withFileTypes: true });
  await Promise.all(
    entries
      .filter((e) => e.isFile())
      .map(async (entry) => {
        const body = await readFile(join(dir, entry.name));
        const contentType = entry.name.endsWith('.m3u8')
          ? 'application/vnd.apple.mpegurl'
          : entry.name.endsWith('.ts')
            ? 'video/MP2T'
            : 'application/octet-stream';
        await s3.send(
          new PutObjectCommand({
            Bucket: bucket,
            Key: `${prefix}/${entry.name}`,
            Body: body,
            ContentType: contentType,
          }),
        );
      }),
  );
}
