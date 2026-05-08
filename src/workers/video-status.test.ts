import { describe, expect, it } from 'vitest';
import {
  TERMINAL_STATUSES,
  VIDEO_STATUSES,
  canTransition,
  isVideoStatus,
  normalizeVideoStatus,
  transitionVideoStatus,
} from './video-status';

describe('isVideoStatus', () => {
  it('accepts canonical statuses', () => {
    for (const s of VIDEO_STATUSES) expect(isVideoStatus(s)).toBe(true);
  });
  it('rejects unknown strings and non-strings', () => {
    expect(isVideoStatus('uploaded')).toBe(false);
    expect(isVideoStatus('encode_failed')).toBe(false);
    expect(isVideoStatus(null)).toBe(false);
    expect(isVideoStatus(42)).toBe(false);
  });
});

describe('normalizeVideoStatus', () => {
  it('passes canonical values through', () => {
    expect(normalizeVideoStatus('ready')).toBe('ready');
    expect(normalizeVideoStatus('queued')).toBe('queued');
  });
  it('maps legacy values onto canonical ones', () => {
    expect(normalizeVideoStatus('uploaded')).toBe('queued');
    expect(normalizeVideoStatus('pending_encode')).toBe('queued');
    expect(normalizeVideoStatus('stream_submitted')).toBe('queued');
    expect(normalizeVideoStatus('encode_failed')).toBe('failed');
  });
  it('returns null for unknown or empty values', () => {
    expect(normalizeVideoStatus(null)).toBe(null);
    expect(normalizeVideoStatus('')).toBe(null);
    expect(normalizeVideoStatus('garbage')).toBe(null);
  });
});

describe('canTransition', () => {
  it('always permits same-state writes (idempotency)', () => {
    for (const s of VIDEO_STATUSES) expect(canTransition(s, s)).toBe(true);
  });

  it('honors the spec uploading → queued → encoding → ready/failed', () => {
    expect(canTransition('uploading', 'queued')).toBe(true);
    expect(canTransition('queued', 'encoding')).toBe(true);
    expect(canTransition('encoding', 'ready')).toBe(true);
    expect(canTransition('encoding', 'failed')).toBe(true);
  });

  it('blocks pulling the lifecycle backwards', () => {
    expect(canTransition('ready', 'encoding')).toBe(false);
    expect(canTransition('ready', 'queued')).toBe(false);
    expect(canTransition('ready', 'uploading')).toBe(false);
    expect(canTransition('encoding', 'queued')).toBe(false);
    expect(canTransition('encoding', 'uploading')).toBe(false);
    expect(canTransition('queued', 'uploading')).toBe(false);
  });

  it('permits failure from any non-terminal state', () => {
    expect(canTransition('uploading', 'failed')).toBe(true);
    expect(canTransition('queued', 'failed')).toBe(true);
    expect(canTransition('encoding', 'failed')).toBe(true);
    expect(canTransition('ready', 'failed')).toBe(true);
  });

  it('permits explicit retry from failed', () => {
    expect(canTransition('failed', 'queued')).toBe(true);
    expect(canTransition('failed', 'encoding')).toBe(true);
  });

  it('classifies ready and failed as terminal', () => {
    expect(TERMINAL_STATUSES.has('ready')).toBe(true);
    expect(TERMINAL_STATUSES.has('failed')).toBe(true);
    expect(TERMINAL_STATUSES.has('encoding')).toBe(false);
  });
});

interface FakeRow {
  id: string;
  status: string;
  stream_video_id: string | null;
}

function makeFakeDB(seed: FakeRow[]) {
  const rows = [...seed];
  return {
    rows,
    db: {
      prepare(_query: string) {
        let bound: unknown[] = [];
        const stmt = {
          bind(...values: unknown[]) {
            bound = values;
            return stmt;
          },
          async run() {
            const [next, streamId, id, ...allowedFrom] = bound as [
              string,
              string | null,
              string,
              ...string[],
            ];
            const allowed = new Set(allowedFrom);
            let changes = 0;
            for (const row of rows) {
              if (row.id === id && allowed.has(row.status)) {
                row.status = next;
                if (streamId !== null) row.stream_video_id = streamId;
                changes++;
              }
            }
            return { meta: { changes } };
          },
        };
        return stmt;
      },
    },
  };
}

describe('transitionVideoStatus', () => {
  it('commits a legal forward transition and reports changes', async () => {
    const fake = makeFakeDB([{ id: 'v1', status: 'queued', stream_video_id: null }]);
    const result = await transitionVideoStatus(fake.db, 'v1', 'encoding');
    expect(result).toEqual({ ok: true, changes: 1 });
    expect(fake.rows[0].status).toBe('encoding');
  });

  it('writes stream_video_id when supplied', async () => {
    const fake = makeFakeDB([{ id: 'v1', status: 'queued', stream_video_id: null }]);
    await transitionVideoStatus(fake.db, 'v1', 'encoding', { streamVideoId: 'cf-uid' });
    expect(fake.rows[0].stream_video_id).toBe('cf-uid');
  });

  it('is idempotent on same-state writes', async () => {
    const fake = makeFakeDB([{ id: 'v1', status: 'ready', stream_video_id: 'cf-uid' }]);
    const result = await transitionVideoStatus(fake.db, 'v1', 'ready');
    expect(result.ok).toBe(true);
    expect(fake.rows[0].status).toBe('ready');
  });

  it('refuses to drag ready back to encoding (no-op)', async () => {
    const fake = makeFakeDB([{ id: 'v1', status: 'ready', stream_video_id: 'cf-uid' }]);
    const result = await transitionVideoStatus(fake.db, 'v1', 'encoding');
    expect(result).toEqual({ ok: false, changes: 0 });
    expect(fake.rows[0].status).toBe('ready');
  });

  it('returns no-op when the row does not exist', async () => {
    const fake = makeFakeDB([]);
    const result = await transitionVideoStatus(fake.db, 'missing', 'encoding');
    expect(result.ok).toBe(false);
    expect(result.changes).toBe(0);
  });
});
