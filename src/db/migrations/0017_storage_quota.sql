-- ALO-139: per-user storage quota tracked at upload time.
--
-- `storage_bytes_quota` is tier configuration on the user row (free vs paid
-- — adjust per user when paid tiers land). `videos.bytes` is the recorded
-- size of each upload; we SUM it on demand to compute current usage rather
-- than maintain a denormalized counter, which avoids a class of races
-- between concurrent upload + delete + cascade-delete sweeps.
--
-- 5GB free-tier default. Existing users are grandfathered to the same
-- value; bump per-user via `UPDATE user SET storage_bytes_quota = ? WHERE id = ?`.

ALTER TABLE user ADD COLUMN storage_bytes_quota INTEGER NOT NULL DEFAULT 5368709120;
ALTER TABLE videos ADD COLUMN bytes INTEGER NOT NULL DEFAULT 0;
