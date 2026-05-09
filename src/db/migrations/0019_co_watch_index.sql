-- ALO-123 (E4): co-watch recommendations index.
--
-- The related-videos endpoint added a co-watch step that self-joins
-- watch_history on user_id to find videos that viewers of the source video
-- also watched. The existing PRIMARY KEY (user_id, video_id) is fine for the
-- "did this user watch this video" lookup, but the inverse — "who watched
-- this video" — needs an index on video_id, otherwise the wh1 anchor scans
-- the whole watch_history table for every recommendation request.

CREATE INDEX IF NOT EXISTS idx_watch_history_video
  ON watch_history(video_id);
