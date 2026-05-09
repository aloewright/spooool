-- ALO-136: R2+FFmpeg fallback encoder writes HLS variants under an R2 key
-- prefix (e.g. `<userId>/<videoId>/hls/`). We store the prefix on the row
-- so /api/videos/:id/hls/* can stream the master + variant playlists +
-- segments straight out of R2 without consulting Cloudflare Stream.
--
-- `playback_hls_url` already exists for the Stream path (3rd-party absolute
-- URL like videodelivery.net/<uid>/manifest/video.m3u8). The new column is
-- the relative R2 key prefix the fallback encoder uses; it's only set when
-- Stream is disabled and the FFmpeg fallback completes successfully.

ALTER TABLE videos ADD COLUMN playback_hls_path TEXT;
