// CI regression guard: verifies that key queries use the expected indexes.
// Runs EXPLAIN QUERY PLAN against the local D1 instance (migrations applied by
// worker-test-apply-migrations.ts) so a dropped or renamed index fails the build.
import { env } from 'cloudflare:test';
import { describe, expect, it } from 'vitest';

interface EqpRow {
  id: number;
  parent: number;
  notused: number;
  detail: string;
}

async function eqp(sql: string): Promise<string[]> {
  const { results } = await env.DB.prepare(`EXPLAIN QUERY PLAN ${sql}`).all<EqpRow>();
  return (results ?? []).map((r) => r.detail);
}

function usesIndex(plan: string[], indexName: string): boolean {
  return plan.some((line) => line.includes(indexName));
}

describe('query plan regression checks', () => {
  it('comments top-level listing uses idx_comments_top_level', async () => {
    const plan = await eqp(
      `SELECT c.id, COUNT(r.id) AS reply_count
       FROM comments c
       LEFT JOIN comments r ON r.parent_comment_id = c.id AND r.deleted_at IS NULL
       WHERE c.video_id = 'x' AND c.parent_comment_id IS NULL AND c.deleted_at IS NULL
       GROUP BY c.id
       ORDER BY c.created_at DESC LIMIT 50`,
    );
    expect(usesIndex(plan, 'idx_comments_top_level'), `plan:\n${plan.join('\n')}`).toBe(true);
  });

  it('comments reply fetch uses idx_comments_replies', async () => {
    const plan = await eqp(
      `SELECT c.id FROM comments c
       WHERE c.parent_comment_id IN ('a','b','c') AND c.deleted_at IS NULL
       ORDER BY c.created_at ASC`,
    );
    expect(usesIndex(plan, 'idx_comments_replies'), `plan:\n${plan.join('\n')}`).toBe(true);
  });

  it('feed channel items use idx_videos_user_feed', async () => {
    const plan = await eqp(
      `SELECT v.id FROM videos v
       WHERE v.user_id = 'u1' AND v.deleted_at IS NULL AND v.hidden_at IS NULL
         AND v.dmca_status IS NULL
       ORDER BY v.created_at DESC LIMIT 15`,
    );
    expect(usesIndex(plan, 'idx_videos_user_feed'), `plan:\n${plan.join('\n')}`).toBe(true);
  });

  it('related same-channel uses idx_videos_channel_ready', async () => {
    const plan = await eqp(
      `SELECT v.id FROM videos v
       WHERE v.user_id = 'u1' AND v.id != 'src'
         AND v.deleted_at IS NULL AND v.hidden_at IS NULL
         AND v.status = 'ready'
         AND (v.dmca_status IS NULL OR v.dmca_status != 'disabled')
       ORDER BY v.created_at DESC LIMIT 12`,
    );
    expect(usesIndex(plan, 'idx_videos_channel_ready'), `plan:\n${plan.join('\n')}`).toBe(true);
  });

  it('related fill-up uses idx_videos_ready_popular', async () => {
    const plan = await eqp(
      `SELECT v.id FROM videos v
       WHERE v.deleted_at IS NULL AND v.hidden_at IS NULL
         AND v.status = 'ready'
         AND (v.dmca_status IS NULL OR v.dmca_status != 'disabled')
       ORDER BY v.view_count DESC, v.created_at DESC LIMIT 12`,
    );
    expect(usesIndex(plan, 'idx_videos_ready_popular'), `plan:\n${plan.join('\n')}`).toBe(true);
  });

  it('watch history listing uses idx_watch_history_user_recent', async () => {
    const plan = await eqp(
      `SELECT h.video_id, h.watched_at FROM watch_history h
       WHERE h.user_id = 'u1'
       ORDER BY h.watched_at DESC LIMIT 20`,
    );
    expect(usesIndex(plan, 'idx_watch_history_user_recent'), `plan:\n${plan.join('\n')}`).toBe(
      true,
    );
  });

  it('trending join uses idx_views_video_viewed_at', async () => {
    const plan = await eqp(
      `SELECT v.id, COUNT(vw.id) AS recent_views FROM videos v
       LEFT JOIN views vw ON vw.video_id = v.id
         AND vw.viewed_at >= datetime('now', '-7 days')
       WHERE v.deleted_at IS NULL AND v.hidden_at IS NULL AND v.status = 'ready'
       GROUP BY v.id
       ORDER BY recent_views DESC LIMIT 10`,
    );
    expect(usesIndex(plan, 'idx_views_video_viewed_at'), `plan:\n${plan.join('\n')}`).toBe(true);
  });
});
