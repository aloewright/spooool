CREATE TABLE IF NOT EXISTS users (
  id TEXT PRIMARY KEY,
  email TEXT NOT NULL UNIQUE,
  username TEXT NOT NULL UNIQUE,
  display_name TEXT,
  deletion_requested_at INTEGER,
  deletion_scheduled_for INTEGER,
  notify_email_new_upload INTEGER NOT NULL DEFAULT 1,
  notify_email_comments INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS idx_user_deletion_scheduled
  ON users(deletion_scheduled_for)
  WHERE deletion_scheduled_for IS NOT NULL;

CREATE TABLE IF NOT EXISTS videos (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL,
  title TEXT NOT NULL,
  description TEXT NOT NULL DEFAULT '',
  r2_key TEXT NOT NULL,
  bytes INTEGER NOT NULL DEFAULT 0,
  stream_video_id TEXT,
  status TEXT NOT NULL DEFAULT 'queued',
  view_count INTEGER NOT NULL DEFAULT 0,
  hidden_at TEXT,
  dmca_status TEXT,
  dmca_restore_eligible_at INTEGER,
  deleted_at TEXT,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (user_id) REFERENCES users(id)
);

CREATE TABLE IF NOT EXISTS dmca_claims (
  id TEXT PRIMARY KEY,
  video_id TEXT NOT NULL,
  complainant_name TEXT NOT NULL,
  complainant_email TEXT NOT NULL,
  complainant_address TEXT NOT NULL,
  complainant_phone TEXT NOT NULL,
  copyrighted_work TEXT NOT NULL,
  infringing_urls TEXT NOT NULL,
  good_faith_signed INTEGER NOT NULL DEFAULT 0,
  perjury_signed INTEGER NOT NULL DEFAULT 0,
  signature TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending'
    CHECK (status IN ('pending', 'disabled', 'dismissed', 'counter_pending', 'restored')),
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  FOREIGN KEY (video_id) REFERENCES videos(id)
);

CREATE TABLE IF NOT EXISTS dmca_counter_notices (
  id TEXT PRIMARY KEY,
  claim_id TEXT NOT NULL,
  uploader_user_id TEXT NOT NULL,
  uploader_name TEXT NOT NULL,
  uploader_address TEXT NOT NULL,
  uploader_phone TEXT NOT NULL,
  uploader_email TEXT NOT NULL,
  statement TEXT NOT NULL,
  signature TEXT NOT NULL,
  consent_to_jurisdiction INTEGER NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL,
  FOREIGN KEY (claim_id) REFERENCES dmca_claims(id)
);

CREATE TABLE IF NOT EXISTS reports (
  id TEXT PRIMARY KEY,
  reporter_user_id TEXT,
  target_type TEXT NOT NULL CHECK (target_type IN ('video', 'comment')),
  target_id TEXT NOT NULL,
  reason TEXT NOT NULL,
  details TEXT NOT NULL DEFAULT '',
  status TEXT NOT NULL DEFAULT 'open' CHECK (status IN ('open', 'actioned', 'dismissed')),
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS moderation_actions (
  id TEXT PRIMARY KEY,
  report_id TEXT,
  admin_user_id TEXT NOT NULL,
  target_type TEXT NOT NULL,
  target_id TEXT NOT NULL,
  action TEXT NOT NULL CHECK (action IN ('approve', 'hide', 'ban', 'dismiss')),
  notes TEXT NOT NULL DEFAULT '',
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS comments (
  id TEXT PRIMARY KEY,
  video_id TEXT NOT NULL,
  user_id TEXT NOT NULL,
  parent_comment_id TEXT,
  body TEXT NOT NULL,
  deleted_at TEXT,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (video_id) REFERENCES videos(id),
  FOREIGN KEY (user_id) REFERENCES users(id),
  FOREIGN KEY (parent_comment_id) REFERENCES comments(id)
);

CREATE TABLE IF NOT EXISTS views (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  video_id TEXT NOT NULL,
  user_id TEXT,
  viewed_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (video_id) REFERENCES videos(id),
  FOREIGN KEY (user_id) REFERENCES users(id)
);

CREATE TABLE IF NOT EXISTS subscriptions (
  id TEXT PRIMARY KEY,
  subscriber_user_id TEXT NOT NULL,
  channel_user_id TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (subscriber_user_id) REFERENCES users(id),
  FOREIGN KEY (channel_user_id) REFERENCES users(id),
  UNIQUE (subscriber_user_id, channel_user_id)
);

CREATE TABLE IF NOT EXISTS playlists (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL,
  name TEXT NOT NULL,
  description TEXT NOT NULL DEFAULT '',
  is_public INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (user_id) REFERENCES users(id)
);

CREATE TABLE IF NOT EXISTS playlist_videos (
  playlist_id TEXT NOT NULL,
  video_id TEXT NOT NULL,
  position INTEGER NOT NULL DEFAULT 0,
  added_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (playlist_id, video_id),
  FOREIGN KEY (playlist_id) REFERENCES playlists(id),
  FOREIGN KEY (video_id) REFERENCES videos(id)
);

CREATE INDEX IF NOT EXISTS idx_videos_user_id ON videos(user_id);
CREATE INDEX IF NOT EXISTS idx_videos_created_at ON videos(created_at DESC);
CREATE INDEX IF NOT EXISTS idx_videos_active_created ON videos(deleted_at, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_comments_video_id ON comments(video_id);
CREATE INDEX IF NOT EXISTS idx_views_video_id ON views(video_id);
CREATE INDEX IF NOT EXISTS idx_views_video_viewed_at ON views(video_id, viewed_at);
CREATE INDEX IF NOT EXISTS idx_subscriptions_subscriber ON subscriptions(subscriber_user_id);
CREATE INDEX IF NOT EXISTS idx_subscriptions_channel ON subscriptions(channel_user_id);
CREATE INDEX IF NOT EXISTS idx_playlist_videos_position ON playlist_videos(playlist_id, position);
CREATE INDEX IF NOT EXISTS idx_reports_status_updated ON reports(status, updated_at DESC);
CREATE INDEX IF NOT EXISTS idx_reports_target ON reports(target_type, target_id);
CREATE INDEX IF NOT EXISTS idx_moderation_actions_report ON moderation_actions(report_id);
CREATE INDEX IF NOT EXISTS idx_moderation_actions_target ON moderation_actions(target_type, target_id);
CREATE INDEX IF NOT EXISTS idx_dmca_claims_status ON dmca_claims(status, updated_at DESC);
CREATE INDEX IF NOT EXISTS idx_dmca_claims_video ON dmca_claims(video_id);
CREATE INDEX IF NOT EXISTS idx_dmca_counter_claim ON dmca_counter_notices(claim_id);

CREATE TABLE IF NOT EXISTS tags (
  slug TEXT PRIMARY KEY,
  label TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS video_tags (
  video_id TEXT NOT NULL,
  tag_slug TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (video_id, tag_slug),
  FOREIGN KEY (video_id) REFERENCES videos(id) ON DELETE CASCADE,
  FOREIGN KEY (tag_slug) REFERENCES tags(slug) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_video_tags_tag ON video_tags(tag_slug);
CREATE INDEX IF NOT EXISTS idx_video_tags_video ON video_tags(video_id);

CREATE TABLE IF NOT EXISTS feeds (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL,
  name TEXT NOT NULL,
  description TEXT NOT NULL DEFAULT '',
  is_public INTEGER NOT NULL DEFAULT 0,
  last_viewed_at INTEGER,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (user_id) REFERENCES user(id)
);

CREATE TABLE IF NOT EXISTS feed_sources (
  id TEXT PRIMARY KEY,
  feed_id TEXT NOT NULL,
  kind TEXT NOT NULL CHECK (kind IN
    ('spooool_channel','youtube_channel','youtube_playlist','youtube_search','tiktok_video')),
  ref TEXT NOT NULL,
  label TEXT NOT NULL DEFAULT '',
  position INTEGER NOT NULL DEFAULT 0,
  added_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (feed_id) REFERENCES feeds(id)
);

CREATE INDEX IF NOT EXISTS idx_feeds_user ON feeds(user_id);
CREATE INDEX IF NOT EXISTS idx_feeds_last_viewed ON feeds(last_viewed_at);
CREATE INDEX IF NOT EXISTS idx_feed_sources_feed ON feed_sources(feed_id);

-- subscription_inbox (from 0009): subscriber fan-out inbox. Defined here so the
-- idx_inbox_unseen partial index below has its target table in this snapshot.
CREATE TABLE IF NOT EXISTS subscription_inbox (
  subscriber_user_id TEXT NOT NULL,
  video_id TEXT NOT NULL,
  channel_user_id TEXT NOT NULL,
  added_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  seen_at TEXT,
  PRIMARY KEY (subscriber_user_id, video_id),
  FOREIGN KEY (subscriber_user_id) REFERENCES users(id) ON DELETE CASCADE,
  FOREIGN KEY (video_id) REFERENCES videos(id),
  FOREIGN KEY (channel_user_id) REFERENCES users(id)
);

CREATE INDEX IF NOT EXISTS idx_inbox_user_added
  ON subscription_inbox(subscriber_user_id, added_at DESC);

-- generated_assets (from 0022): studio AI artefacts. Defined here so the
-- idx_generated_assets_user_kind_status index below has its target table.
-- The studio subtree (edit_projects, render_jobs, ai_costs) is intentionally
-- omitted from this reference snapshot, so the project_id FK to edit_projects is
-- dropped here (the column is kept). See migration 0022 for the full definition.
CREATE TABLE IF NOT EXISTS generated_assets (
  id TEXT PRIMARY KEY NOT NULL,
  user_id TEXT NOT NULL,
  kind TEXT NOT NULL CHECK (kind IN ('image','video','audio','caption','metadata','clip')),
  source TEXT NOT NULL CHECK (source IN ('image_gen','video_gen','audio_gen','stt_gen','text_gen','stream_clip')),
  r2_key TEXT,
  stream_video_id TEXT,
  bytes INTEGER NOT NULL DEFAULT 0,
  status TEXT NOT NULL CHECK (status IN ('queued','processing','ready','failed')),
  spec_json TEXT,
  error_message TEXT,
  project_id TEXT,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  FOREIGN KEY (user_id) REFERENCES users(id)
);

CREATE INDEX IF NOT EXISTS idx_generated_assets_user_kind ON generated_assets(user_id, kind);
CREATE INDEX IF NOT EXISTS idx_generated_assets_stream_video ON generated_assets(stream_video_id);

CREATE INDEX IF NOT EXISTS idx_videos_browse
  ON videos(created_at DESC)
  WHERE deleted_at IS NULL AND hidden_at IS NULL;

CREATE INDEX IF NOT EXISTS idx_comments_replies
  ON comments(parent_comment_id, deleted_at, created_at ASC);

CREATE INDEX IF NOT EXISTS idx_generated_assets_user_kind_status
  ON generated_assets(user_id, kind, status);

CREATE INDEX IF NOT EXISTS idx_inbox_unseen
  ON subscription_inbox(subscriber_user_id, added_at DESC)
  WHERE seen_at IS NULL;

CREATE INDEX IF NOT EXISTS idx_comments_top_level
  ON comments(video_id, parent_comment_id, deleted_at, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_videos_user_feed
  ON videos(user_id, deleted_at, hidden_at, dmca_status, created_at DESC);
