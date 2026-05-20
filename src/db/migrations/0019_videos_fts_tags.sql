-- ALO-150: extend videos FTS5 to include tags alongside title/description/channel.
--
-- FTS5 doesn't support adding columns to an existing virtual table, so we
-- drop and recreate the index plus the triggers that keep it in sync. Tags
-- are joined as a single space-separated string (labels + slugs) so a search
-- for either form matches.

DROP TRIGGER IF EXISTS videos_fts_ai;
DROP TRIGGER IF EXISTS videos_fts_au;
DROP TRIGGER IF EXISTS videos_fts_ad;
DROP TRIGGER IF EXISTS user_name_videos_fts;
DROP TABLE IF EXISTS videos_fts;

CREATE VIRTUAL TABLE videos_fts USING fts5(
  video_id UNINDEXED,
  title,
  description,
  channel_name,
  tags,
  tokenize = "unicode61 remove_diacritics 2"
);

-- Backfill: aggregate each video's tags into a single text blob (labels + slugs).
INSERT INTO videos_fts (video_id, title, description, channel_name, tags)
  SELECT v.id,
         v.title,
         v.description,
         COALESCE(u.name, ''),
         COALESCE(
           (SELECT GROUP_CONCAT(t.label || ' ' || t.slug, ' ')
              FROM video_tags vt
              JOIN tags t ON t.slug = vt.tag_slug
             WHERE vt.video_id = v.id),
           ''
         )
    FROM videos v
    LEFT JOIN user u ON u.id = v.user_id
   WHERE v.deleted_at IS NULL;

CREATE TRIGGER videos_fts_ai AFTER INSERT ON videos
WHEN new.deleted_at IS NULL
BEGIN
  INSERT INTO videos_fts (video_id, title, description, channel_name, tags)
  VALUES (
    new.id,
    new.title,
    new.description,
    COALESCE((SELECT name FROM user WHERE id = new.user_id), ''),
    COALESCE(
      (SELECT GROUP_CONCAT(t.label || ' ' || t.slug, ' ')
         FROM video_tags vt
         JOIN tags t ON t.slug = vt.tag_slug
        WHERE vt.video_id = new.id),
      ''
    )
  );
END;

CREATE TRIGGER videos_fts_au
AFTER UPDATE OF title, description, user_id, deleted_at ON videos
BEGIN
  DELETE FROM videos_fts WHERE video_id = old.id;
  INSERT INTO videos_fts (video_id, title, description, channel_name, tags)
    SELECT new.id,
           new.title,
           new.description,
           COALESCE(u.name, ''),
           COALESCE(
             (SELECT GROUP_CONCAT(t.label || ' ' || t.slug, ' ')
                FROM video_tags vt
                JOIN tags t ON t.slug = vt.tag_slug
               WHERE vt.video_id = new.id),
             ''
           )
      FROM (SELECT 1) AS s LEFT JOIN user u ON u.id = new.user_id
     WHERE new.deleted_at IS NULL;
END;

CREATE TRIGGER videos_fts_ad AFTER DELETE ON videos BEGIN
  DELETE FROM videos_fts WHERE video_id = old.id;
END;

CREATE TRIGGER user_name_videos_fts
AFTER UPDATE OF name ON user
BEGIN
  DELETE FROM videos_fts WHERE video_id IN (SELECT id FROM videos WHERE user_id = new.id);
  INSERT INTO videos_fts (video_id, title, description, channel_name, tags)
    SELECT v.id,
           v.title,
           v.description,
           new.name,
           COALESCE(
             (SELECT GROUP_CONCAT(t.label || ' ' || t.slug, ' ')
                FROM video_tags vt
                JOIN tags t ON t.slug = vt.tag_slug
               WHERE vt.video_id = v.id),
             ''
           )
      FROM videos v
     WHERE v.user_id = new.id AND v.deleted_at IS NULL;
END;

-- Keep tags column in sync when video_tags rows are inserted/deleted.
CREATE TRIGGER video_tags_ai_fts AFTER INSERT ON video_tags
BEGIN
  UPDATE videos_fts
     SET tags = COALESCE(
       (SELECT GROUP_CONCAT(t.label || ' ' || t.slug, ' ')
          FROM video_tags vt
          JOIN tags t ON t.slug = vt.tag_slug
         WHERE vt.video_id = new.video_id),
       ''
     )
   WHERE video_id = new.video_id;
END;

CREATE TRIGGER video_tags_ad_fts AFTER DELETE ON video_tags
BEGIN
  UPDATE videos_fts
     SET tags = COALESCE(
       (SELECT GROUP_CONCAT(t.label || ' ' || t.slug, ' ')
          FROM video_tags vt
          JOIN tags t ON t.slug = vt.tag_slug
         WHERE vt.video_id = old.video_id),
       ''
     )
   WHERE video_id = old.video_id;
END;

-- If a tag's label changes, refresh all videos carrying that tag.
CREATE TRIGGER tags_au_label_fts
AFTER UPDATE OF label ON tags
BEGIN
  UPDATE videos_fts
     SET tags = COALESCE(
       (SELECT GROUP_CONCAT(t.label || ' ' || t.slug, ' ')
          FROM video_tags vt
          JOIN tags t ON t.slug = vt.tag_slug
         WHERE vt.video_id = videos_fts.video_id),
       ''
     )
   WHERE video_id IN (SELECT video_id FROM video_tags WHERE tag_slug = new.slug);
END;
