// Query-plan regression tests.
//
// Each test runs EXPLAIN QUERY PLAN on a hot-path query and asserts that
// SQLite never falls back to a full table scan (a SCAN without a USING
// clause). The tests run in the workers vitest pool so the same D1 binding
// used by worker integration tests is available, with all migrations applied.
//
// If a test starts failing after an index is removed or a query changes, add
// the matching index or rewrite the query before merging.

import { env } from 'cloudflare:test';
import { describe, expect, it } from 'vitest';

type ExplainRow = { id: number; parent: number; notused: number; detail: string };

async function queryPlan(sql: string, ...params: unknown[]): Promise<ExplainRow[]> {
  const { results } = await (env.DB as D1Database)
    .prepare(`EXPLAIN QUERY PLAN ${sql}`)
    .bind(...params)
    .all<ExplainRow>();
  return results;
}

function assertNoFullScan(plan: ExplainRow[], context: string): void {
  // A full table scan has "SCAN <table>" with no USING clause.
  // Index scans look like "SCAN <table> USING INDEX …" or
  // "SEARCH <table> USING INDEX …" — both are acceptable.
  const fullScans = plan.filter((r) => {
    const d = r.detail.trim();
    return d.startsWith('SCAN ') && !d.includes(' USING ');
  });
  if (fullScans.length > 0) {
    const allDetails = plan.map((r) => `  ${r.detail}`).join('\n');
    expect.fail(`Full table scan detected in "${context}":\n${allDetails}`);
  }
}

describe('query plan — hot-path queries must use indexes', () => {
  it('browse videos: deleted_at IS NULL AND hidden_at IS NULL ORDER BY created_at DESC', async () => {
    const plan = await queryPlan(
      `SELECT id, title FROM videos
       WHERE deleted_at IS NULL AND hidden_at IS NULL
       ORDER BY created_at DESC LIMIT 20 OFFSET 0`,
    );
    assertNoFullScan(plan, 'browse videos');
  });

  it('trending videos: GROUP BY with LEFT JOIN views', async () => {
    const plan = await queryPlan(
      `SELECT v.id, COUNT(views.id) AS recent_views
       FROM videos v
       LEFT JOIN views ON views.video_id = v.id
         AND views.viewed_at >= datetime('now', '-7 days')
       WHERE v.deleted_at IS NULL AND v.hidden_at IS NULL
       GROUP BY v.id
       ORDER BY recent_views DESC LIMIT 12`,
    );
    assertNoFullScan(plan, 'trending videos');
  });

  it('comments listing: video_id + parent IS NULL + deleted_at IS NULL', async () => {
    const plan = await queryPlan(
      `SELECT c.id FROM comments c
       WHERE c.video_id = ? AND c.parent_comment_id IS NULL AND c.deleted_at IS NULL
       ORDER BY c.created_at DESC LIMIT 50 OFFSET 0`,
      'dummy-video-id',
    );
    assertNoFullScan(plan, 'comments listing');
  });

  it('comment replies: parent_comment_id IN (...) + deleted_at IS NULL', async () => {
    const plan = await queryPlan(
      `SELECT id FROM comments
       WHERE parent_comment_id = ? AND deleted_at IS NULL
       ORDER BY created_at ASC`,
      'dummy-comment-id',
    );
    assertNoFullScan(plan, 'comment replies');
  });

  it('subscription check: LEFT JOIN with channel lookup by username', async () => {
    const plan = await queryPlan(
      `SELECT u.id, COUNT(s.id) AS subscriber_count
       FROM user u
       LEFT JOIN subscriptions s ON s.channel_user_id = u.id
       WHERE u.username = ?
       GROUP BY u.id`,
      'dummy-user',
    );
    assertNoFullScan(plan, 'subscription check');
  });

  it('subscription inbox feed: subscriber_user_id ORDER BY added_at DESC', async () => {
    const plan = await queryPlan(
      `SELECT video_id FROM subscription_inbox
       WHERE subscriber_user_id = ?
       ORDER BY added_at DESC LIMIT 50 OFFSET 0`,
      'dummy-user-id',
    );
    assertNoFullScan(plan, 'inbox feed');
  });

  it('inbox unseen count: subscriber_user_id + seen_at IS NULL', async () => {
    const plan = await queryPlan(
      `SELECT COUNT(*) FROM subscription_inbox
       WHERE subscriber_user_id = ? AND seen_at IS NULL`,
      'dummy-user-id',
    );
    assertNoFullScan(plan, 'inbox unseen count');
  });

  it('generated assets lookup: user_id + kind + status', async () => {
    const plan = await queryPlan(
      `SELECT id FROM generated_assets
       WHERE user_id = ? AND kind = 'image' AND status = 'ready'`,
      'dummy-user-id',
    );
    assertNoFullScan(plan, 'generated assets lookup');
  });

  it('ai_costs daily cap: user_id + created_at range', async () => {
    const plan = await queryPlan(
      `SELECT COUNT(*) FROM ai_costs WHERE user_id = ? AND created_at >= ?`,
      'dummy-user-id', 0,
    );
    assertNoFullScan(plan, 'ai_costs daily cap');
  });

  it('render jobs stuck sweep: status + updated_at', async () => {
    const plan = await queryPlan(
      `UPDATE render_jobs SET status = 'failed', updated_at = ?
       WHERE status = 'rendering' AND updated_at < ?`,
      0, 0,
    );
    assertNoFullScan(plan, 'render jobs stuck sweep');
  });
});
