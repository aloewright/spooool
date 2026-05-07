import { describe, expect, it } from 'vitest';
import {
  FREE_TIER_QUOTA_BYTES,
  getStorageUsage,
  hasRoomFor,
  type StorageQuotaEnv,
} from './storage-quota';

interface Stmt {
  bind(...values: unknown[]): Stmt;
  first<T = unknown>(): Promise<T | null>;
}

function fakeEnv(opts: { sumBytes: number | null; quota: number | null }): StorageQuotaEnv {
  return {
    DB: {
      prepare(sql: string): Stmt {
        let bound: unknown[] = [];
        const trimmed = sql.replace(/\s+/g, ' ').trim();
        const api: Stmt = {
          bind(...v: unknown[]) {
            bound = v;
            return api;
          },
          async first() {
            if (trimmed.startsWith('SELECT COALESCE(SUM(bytes)')) {
              expect(bound[0]).toBe('u1');
              return { used: opts.sumBytes } as never;
            }
            if (trimmed.startsWith('SELECT storage_bytes_quota AS quota FROM user')) {
              expect(bound[0]).toBe('u1');
              return opts.quota === null ? null : ({ quota: opts.quota } as never);
            }
            return null;
          },
        };
        return api;
      },
    } as unknown as D1Database,
  };
}

describe('hasRoomFor', () => {
  it('true when used + incoming <= quota', () => {
    expect(hasRoomFor({ used: 100, quota: 200, remaining: 100 }, 100)).toBe(true);
  });
  it('false when used + incoming > quota', () => {
    expect(hasRoomFor({ used: 100, quota: 200, remaining: 100 }, 101)).toBe(false);
  });
  it('true at exact boundary', () => {
    expect(hasRoomFor({ used: 200, quota: 200, remaining: 0 }, 0)).toBe(true);
  });
});

describe('getStorageUsage', () => {
  it('returns SUM(bytes) and the user-row quota', async () => {
    const env = fakeEnv({ sumBytes: 1024, quota: 4096 });
    const u = await getStorageUsage(env, 'u1');
    expect(u).toEqual({ used: 1024, quota: 4096, remaining: 3072 });
  });

  it('treats SUM null (no videos) as 0 used', async () => {
    const env = fakeEnv({ sumBytes: null, quota: 4096 });
    const u = await getStorageUsage(env, 'u1');
    expect(u.used).toBe(0);
    expect(u.remaining).toBe(4096);
  });

  it('falls back to FREE_TIER_QUOTA_BYTES when user row is missing', async () => {
    const env = fakeEnv({ sumBytes: 0, quota: null });
    const u = await getStorageUsage(env, 'u1');
    expect(u.quota).toBe(FREE_TIER_QUOTA_BYTES);
  });

  it('clamps remaining to 0 when over quota (e.g. quota lowered after upload)', async () => {
    const env = fakeEnv({ sumBytes: 5000, quota: 1000 });
    const u = await getStorageUsage(env, 'u1');
    expect(u.used).toBe(5000);
    expect(u.quota).toBe(1000);
    expect(u.remaining).toBe(0);
  });
});
