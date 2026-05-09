CREATE TABLE IF NOT EXISTS users (
  id TEXT PRIMARY KEY,
  email TEXT NOT NULL UNIQUE,
  username TEXT NOT NULL UNIQUE,
  display_name TEXT,
  deletion_requested_at INTEGER,
  deletion_scheduled_for INTEGER,
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

CREATE TABLE IF NOT EXISTS video_captions (
  video_id TEXT NOT NULL,
  language TEXT NOT NULL,
  label TEXT NOT NULL,
  r2_key TEXT NOT NULL,
  is_default INTEGER NOT NULL DEFAULT 0,
  bytes INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (video_id, language),
  FOREIGN KEY (video_id) REFERENCES videos(id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_video_captions_video ON video_captions(video_id);
