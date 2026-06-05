// Stub for @aws-sdk/client-s3 used only by the root vitest pool. The root
// `include` glob picks up container/render/src/**/*.test.ts, and encode.ts
// imports the S3 client at module load. Those deps live in the container's own
// node_modules (not installed at the repo root in CI), and the root tests only
// exercise pure helpers like buildMasterPlaylist, so the client is never used.
export class GetObjectCommand {
  constructor(public readonly input?: unknown) {}
}

export class PutObjectCommand {
  constructor(public readonly input?: unknown) {}
}

export class S3Client {
  send(): Promise<never> {
    throw new Error('S3Client is stubbed in the root vitest pool');
  }
}
