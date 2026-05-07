// ALO-139: per-user storage quota.
//
// Usage is the SUM of `videos.bytes` for non-deleted rows owned by the
// user. Deriving it instead of maintaining a denormalized counter keeps
// the cascade-delete sweep, soft-delete restoration (DMCA counter-notice),
// and concurrent uploads from drifting against the truth. The aggregate
// hits the existing `idx_videos_user_id` index on a small per-user
// rowset, so it's cheap.

export const FREE_TIER_QUOTA_BYTES = 5 * 1024 * 1024 * 1024; // 5 GiB

export interface StorageQuotaEnv {
  DB: D1Database;
}

export type StorageUsage = {
  used: number;
  quota: number;
  remaining: number;
};

export async function getStorageUsage(
  env: StorageQuotaEnv,
  userId: string,
): Promise<StorageUsage> {
  const [usageRow, userRow] = await Promise.all([
    env.DB.prepare(
      `SELECT COALESCE(SUM(bytes), 0) AS used
       FROM videos
       WHERE user_id = ? AND deleted_at IS NULL`,
    )
      .bind(userId)
      .first<{ used: number | null }>(),
    env.DB.prepare(`SELECT storage_bytes_quota AS quota FROM user WHERE id = ?`)
      .bind(userId)
      .first<{ quota: number | null }>(),
  ]);
  const used = Number(usageRow?.used ?? 0);
  const quota = Number(userRow?.quota ?? FREE_TIER_QUOTA_BYTES);
  return { used, quota, remaining: Math.max(0, quota - used) };
}

// Returns true when the user has room for `incomingBytes` more without
// exceeding their quota. Pure projection — no writes — so callers can use
// it as a precheck before paying the cost of a multipart upload.
export function hasRoomFor(usage: StorageUsage, incomingBytes: number): boolean {
  return usage.used + incomingBytes <= usage.quota;
}
