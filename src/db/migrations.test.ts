/// <reference types="node" />
import { readFileSync, readdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const HERE = dirname(fileURLToPath(import.meta.url));
const MIGRATIONS_DIR = join(HERE, 'migrations');
const SCHEMA_PATH = join(HERE, 'schema.sql');

describe('D1 migrations', () => {
  it('migrations are applied in numeric order', () => {
    const files = readdirSync(MIGRATIONS_DIR)
      .filter((f: string) => f.endsWith('.sql'))
      .sort();
    expect(files.length).toBeGreaterThan(0);
    files.forEach((f: string, i: number) => {
      const prefix = f.split('_')[0];
      expect(prefix).toMatch(/^\d{4}$/);
      expect(Number(prefix)).toBe(i + 1);
    });
  });

  it('0010_perf_indexes adds composite indexes for trending + soft-delete (ALO-200)', () => {
    const sql = readFileSync(join(MIGRATIONS_DIR, '0010_perf_indexes.sql'), 'utf8');
    expect(sql).toMatch(/idx_views_video_viewed_at\s+ON\s+views\(video_id,\s*viewed_at\)/i);
    expect(sql).toMatch(/idx_videos_active_created\s+ON\s+videos\(deleted_at,\s*created_at DESC\)/i);
  });

  it('schema.sql mirrors the perf indexes from 0010', () => {
    const schema = readFileSync(SCHEMA_PATH, 'utf8');
    expect(schema).toContain('idx_views_video_viewed_at');
    expect(schema).toContain('idx_videos_active_created');
  });

  it('0011_moderation introduces reports + audit log + hidden/banned columns (ALO-171)', () => {
    const sql = readFileSync(join(MIGRATIONS_DIR, '0011_moderation.sql'), 'utf8');
    expect(sql).toMatch(/CREATE TABLE IF NOT EXISTS reports/);
    expect(sql).toMatch(/CREATE TABLE IF NOT EXISTS moderation_actions/);
    expect(sql).toMatch(/ALTER TABLE videos ADD COLUMN hidden_at/);
    expect(sql).toMatch(/ALTER TABLE user ADD COLUMN banned_at/);
  });

  it('0012_account_deletion adds GDPR grace columns + index (ALO-132)', () => {
    const sql = readFileSync(join(MIGRATIONS_DIR, '0012_account_deletion.sql'), 'utf8');
    expect(sql).toMatch(/ALTER TABLE user ADD COLUMN deletion_requested_at/);
    expect(sql).toMatch(/ALTER TABLE user ADD COLUMN deletion_scheduled_for/);
    expect(sql).toMatch(/idx_user_deletion_scheduled/);
  });

  it('0013_dmca adds claim/counter-notice tables + status columns (ALO-170)', () => {
    const sql = readFileSync(join(MIGRATIONS_DIR, '0013_dmca.sql'), 'utf8');
    expect(sql).toMatch(/CREATE TABLE IF NOT EXISTS dmca_claims/);
    expect(sql).toMatch(/CREATE TABLE IF NOT EXISTS dmca_counter_notices/);
    expect(sql).toMatch(/ALTER TABLE videos ADD COLUMN dmca_status/);
    expect(sql).toMatch(/ALTER TABLE videos ADD COLUMN dmca_restore_eligible_at/);
  });

  it('0016_video_tags adds tags + video_tags tables and indexes (ALO-151)', () => {
    const sql = readFileSync(join(MIGRATIONS_DIR, '0016_video_tags.sql'), 'utf8');
    expect(sql).toMatch(/CREATE TABLE IF NOT EXISTS tags/);
    expect(sql).toMatch(/CREATE TABLE IF NOT EXISTS video_tags/);
    expect(sql).toMatch(/idx_video_tags_tag\s+ON\s+video_tags\(tag_slug\)/i);
    expect(sql).toMatch(/idx_video_tags_video\s+ON\s+video_tags\(video_id\)/i);
  });

  it('schema.sql mirrors the tag tables from 0016', () => {
    const schema = readFileSync(SCHEMA_PATH, 'utf8');
    expect(schema).toContain('CREATE TABLE IF NOT EXISTS tags');
    expect(schema).toContain('CREATE TABLE IF NOT EXISTS video_tags');
    expect(schema).toContain('idx_video_tags_tag');
  });

  it('0019_videos_fts_tags adds tags to the FTS index + sync triggers (ALO-150)', () => {
    const sql = readFileSync(join(MIGRATIONS_DIR, '0019_videos_fts_tags.sql'), 'utf8');
    // FTS5 doesn't support adding columns, so the migration drops and recreates.
    expect(sql).toMatch(/DROP TABLE IF EXISTS videos_fts/);
    expect(sql).toMatch(/CREATE VIRTUAL TABLE videos_fts USING fts5\([^)]*tags[^)]*\)/s);
    // Backfill aggregates each video's tags into the new FTS column.
    expect(sql).toMatch(/GROUP_CONCAT\(t\.label/);
    // Triggers on video_tags and tags keep the FTS row in sync with mutations.
    expect(sql).toMatch(/AFTER INSERT ON video_tags/);
    expect(sql).toMatch(/AFTER DELETE ON video_tags/);
    expect(sql).toMatch(/AFTER UPDATE OF label ON tags/);
  });
});
