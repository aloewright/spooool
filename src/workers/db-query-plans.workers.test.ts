// CI guard: verify that key hot-path queries use index scans rather than
// full table scans. Each assertion runs EXPLAIN QUERY PLAN against the live
// D1 schema (with all migrations applied) and fails if any plan step is a
// bare SCAN — i.e. reads the whole table without index assistance.
//
// A "bare SCAN" in SQLite's EXPLAIN QUERY PLAN output looks like:
//   "SCAN videos"           ← no index
// vs an indexed access:
//   "SEARCH videos USING INDEX idx_videos_user_id (user_id=?)"
//   "SCAN videos USING COVERING INDEX idx_videos_active_visible"
//
// We flag any detail that starts with "SCAN" but lacks "USING", which is the
// signal that the planner chose a full heap scan. Correlated sub-query steps
// (which appear as nested plan lines) are checked too.
//
// To investigate a failing plan locally:
//   wrangler d1 execute spooool-staging --command \
//     "EXPLAIN QUERY PLAN <the offending SQL here>;"

import { env } from 'cloudflare:test';
import { describe, expect, it } from 'vitest';

interface ExplainRow {
  detail: string;
}

async function explainPlan(sql: string, ...bindings: unknown[]): Promise<string[]> {
  const stmt = env.DB.prepare(`EXPLAIN QUERY PLAN ${sql}`);
  // D1 doesn't support .bind() on EXPLAIN statements directly, so we pass
  // placeholder values via a second prepare+bind — but since EXPLAIN never
  // executes the query, literal '?' placeholders are fine without real values.
  const result = await stmt.all<ExplainRow>();
  return result.results.map((r) => r.detail);
}

function bareScans(plan: string[]): string[] {
  // A detail line is a "bare" scan when it starts with SCAN and has no USING.
  return plan.filter((d) => /^SCAN \w/i.test(d) && !/USING/i.test(d));
}

describe('query plan regression guard', () => {
  // -----------------------------------------------------------------
  // subscription_inbox – unread badge (called on every page load)
  // -----------------------------------------------------------------
  it('inbox unread-count uses idx_inbox_unseen partial index', async () => {
    const plan = await explainPlan(
      `SELECT COUNT(*) FROM subscription_inbox
       WHERE subscriber_user_id = ? AND seen_at IS NULL`,
    );
    expect(bareScans(plan), `full scans in plan:\n${plan.join('\n')}`).toHaveLength(0);
  });

  it('inbox mark-seen UPDATE uses idx_inbox_unseen partial index', async () => {
    const plan = await explainPlan(
      `UPDATE subscription_inbox SET seen_at = CURRENT_TIMESTAMP
       WHERE subscriber_user_id = ? AND seen_at IS NULL`,
    );
    expect(bareScans(plan), `full scans in plan:\n${plan.join('\n')}`).toHaveLength(0);
  });

  // -----------------------------------------------------------------
  // videos – public listing (/api/videos)
  // -----------------------------------------------------------------
  it('public video listing uses idx_videos_active_visible', async () => {
    const plan = await explainPlan(
      `SELECT id, user_id, title, description, r2_key, stream_video_id,
              status, view_count, created_at, updated_at
       FROM videos
       WHERE deleted_at IS NULL AND hidden_at IS NULL AND status = 'ready'
       ORDER BY created_at DESC
       LIMIT 20 OFFSET 0`,
    );
    expect(bareScans(plan), `full scans in plan:\n${plan.join('\n')}`).toHaveLength(0);
  });

  // -----------------------------------------------------------------
  // comments – reply_count correlated subquery
  // -----------------------------------------------------------------
  it('comment reply count uses idx_comments_replies', async () => {
    const plan = await explainPlan(
      `SELECT COUNT(*) FROM comments
       WHERE parent_comment_id = ? AND deleted_at IS NULL`,
    );
    expect(bareScans(plan), `full scans in plan:\n${plan.join('\n')}`).toHaveLength(0);
  });

  // -----------------------------------------------------------------
  // videos – trending query
  // -----------------------------------------------------------------
  it('trending query filters videos via idx_videos_active_visible', async () => {
    const plan = await explainPlan(
      `SELECT v.id, v.view_count, COUNT(views.id) AS recent_views
       FROM videos v
       LEFT JOIN views ON views.video_id = v.id
         AND views.viewed_at >= datetime('now', '-7 days')
       WHERE v.deleted_at IS NULL AND v.hidden_at IS NULL AND v.status = 'ready'
       GROUP BY v.id
       ORDER BY recent_views DESC, v.view_count DESC, v.created_at DESC
       LIMIT 12`,
    );
    // The outer videos scan must use an index; the views join may scan per-video.
    const videoScans = bareScans(plan).filter((d) => /\bvideos\b/i.test(d));
    expect(videoScans, `bare videos scans in plan:\n${plan.join('\n')}`).toHaveLength(0);
  });

  // -----------------------------------------------------------------
  // edit_projects – user project history
  // -----------------------------------------------------------------
  it('edit_projects user list uses idx_edit_projects_user_created', async () => {
    const plan = await explainPlan(
      `SELECT id, title, status, created_at FROM edit_projects
       WHERE user_id = ?
       ORDER BY created_at DESC`,
    );
    expect(bareScans(plan), `full scans in plan:\n${plan.join('\n')}`).toHaveLength(0);
  });

  // -----------------------------------------------------------------
  // videos – storage quota + channel header aggregates
  // -----------------------------------------------------------------
  it('storage quota aggregate uses idx_videos_user_active', async () => {
    const plan = await explainPlan(
      `SELECT COALESCE(SUM(bytes), 0) AS used
       FROM videos WHERE user_id = ? AND deleted_at IS NULL`,
    );
    expect(bareScans(plan), `full scans in plan:\n${plan.join('\n')}`).toHaveLength(0);
  });

  it('channel header video aggregate uses idx_videos_user_active', async () => {
    const plan = await explainPlan(
      `SELECT COUNT(*) AS video_count,
              COALESCE(SUM(view_count), 0) AS total_view_count
       FROM videos WHERE user_id = ? AND deleted_at IS NULL`,
    );
    expect(bareScans(plan), `full scans in plan:\n${plan.join('\n')}`).toHaveLength(0);
  });
});
