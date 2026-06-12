import { describe, expect, it } from "vitest";
import * as schema from "../../apps/web/src/db/schema";

describe("D1 schema", () => {
  it("exports expected tables", () => {
    const tableNames = Object.keys(schema);
    for (const name of [
      "users",
      "voices",
      "voice_samples",
      "projects",
      "blogs",
      "blog_posts",
      "outlines",
      "chapters",
      "sections",
      "revisions",
      "chat_messages",
      "market_queries",
      "market_findings",
      "dataset_snapshots",
      "publisher_packs",
      "gtm_briefs",
      "render_jobs",
      "usage_daily",
    ]) {
      expect(tableNames).toContain(name);
    }
  });

  it("projects.user_id references users", () => {
    // biome-ignore lint/suspicious/noExplicitAny: drizzle internal symbol access for test
    const cols = (schema.projects as any)[Symbol.for("drizzle:Columns")];
    expect(cols.user_id).toBeDefined();
  });
});
