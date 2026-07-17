import { SELF } from "cloudflare:test";
import { describe, expect, it } from "vitest";

async function signUp() {
  const res = await SELF.fetch("http://localhost:5173/api/auth/sign-up/email", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      email: `u-${crypto.randomUUID()}@x.test`,
      password: "correct-horse-battery-staple",
      name: "T",
    }),
  });
  return res.headers.get("set-cookie") ?? "";
}

function blogPayload(overrides: Record<string, unknown> = {}) {
  return {
    title: "Field Notes",
    format: "how-to",
    description: "Step-by-step guides for shipping production AI systems.",
    audience: ["Practitioners", "Beginners"],
    voice_links: [],
    voice_uploads: [{ name: "sample.md", text: "Short, direct sentences. Code first." }],
    voice_profile_md: "## Voice summary\nDirect and practical.",
    rules_do: ["Cite primary sources"],
    rules_dont: ["No em-dashes"],
    ...overrides,
  };
}

describe("blogs", () => {
  it("create + list + get + plan + posts + soft-delete + restore", async () => {
    const cookie = await signUp();
    const headers = { "Content-Type": "application/json", cookie };

    const created = await SELF.fetch("http://localhost:5173/api/v1/blogs", {
      method: "POST",
      headers,
      body: JSON.stringify(blogPayload()),
    });
    expect(created.status).toBe(201);
    // biome-ignore lint/suspicious/noExplicitAny: response shape from our own API
    const { id } = (await created.json()) as any;

    const list = await SELF.fetch("http://localhost:5173/api/v1/blogs", { headers });
    // biome-ignore lint/suspicious/noExplicitAny: response shape from our own API
    const items = (await list.json()) as any;
    // biome-ignore lint/suspicious/noExplicitAny: row shape from our own API
    expect(items.items.find((b: any) => b.id === id)).toBeTruthy();

    const got = await SELF.fetch(`http://localhost:5173/api/v1/blogs/${id}`, { headers });
    expect(got.status).toBe(200);
    // biome-ignore lint/suspicious/noExplicitAny: response shape from our own API
    const blog = (await got.json()) as any;
    expect(blog.format).toBe("how-to");
    expect(blog.audience_json).toEqual(["Practitioners", "Beginners"]);
    expect(blog.rules_dont_json).toEqual(["No em-dashes"]);
    expect(blog.voice_profile_md).toContain("Voice summary");

    const badStructure = await SELF.fetch(`http://localhost:5173/api/v1/blogs/${id}/plan`, {
      method: "POST",
      headers,
      body: JSON.stringify({ structure: "episodic-arc", planned_posts: 1 }),
    });
    expect(badStructure.status).toBe(400);

    const planned = await SELF.fetch(`http://localhost:5173/api/v1/blogs/${id}/plan`, {
      method: "POST",
      headers,
      body: JSON.stringify({ structure: "single-tutorial", planned_posts: 2 }),
    });
    expect(planned.status).toBe(200);
    // biome-ignore lint/suspicious/noExplicitAny: response shape from our own API
    const planBody = (await planned.json()) as any;
    expect(planBody.posts_created).toBe(2);

    const posts = await SELF.fetch(`http://localhost:5173/api/v1/blogs/${id}/posts`, { headers });
    expect(posts.status).toBe(200);
    // biome-ignore lint/suspicious/noExplicitAny: response shape from our own API
    const postsBody = (await posts.json()) as any;
    expect(postsBody.items).toHaveLength(2);
    expect(postsBody.items[0].ordinal).toBe(1);
    expect(postsBody.items[0].status).toBe("planned");

    // Replanning below the number of already-created posts is rejected.
    const replanTooFew = await SELF.fetch(`http://localhost:5173/api/v1/blogs/${id}/plan`, {
      method: "POST",
      headers,
      body: JSON.stringify({ structure: "single-tutorial", planned_posts: 1 }),
    });
    expect(replanTooFew.status).toBe(400);

    const postId = postsBody.items[0].id;
    const postDraftSessionId = crypto.randomUUID();
    const draftJson = [{ type: "paragraph", content: "Step one." }];
    const unversionedDraft = await SELF.fetch(`http://localhost:5173/api/v1/blogs/${id}/posts/${postId}`, {
      method: "PATCH",
      headers,
      body: JSON.stringify({ draft_md: "Missing its write order." }),
    });
    expect(unversionedDraft.status).toBe(400);
    const patchPost = await SELF.fetch(`http://localhost:5173/api/v1/blogs/${id}/posts/${postId}`, {
      method: "PATCH",
      headers,
      body: JSON.stringify({
        title: "Ship it",
        draft_json: draftJson,
        draft_md: "Step one.",
        draft_version: 0,
        draft_session_id: postDraftSessionId,
        draft_sequence: 1,
        status: "drafted",
      }),
    });
    expect(patchPost.status).toBe(200);

    const gotPost = await SELF.fetch(`http://localhost:5173/api/v1/blogs/${id}/posts/${postId}`, {
      headers,
    });
    expect(gotPost.status).toBe(200);
    // biome-ignore lint/suspicious/noExplicitAny: response shape from our own API
    const postBody = (await gotPost.json()) as any;
    expect(postBody.title).toBe("Ship it");
    expect(postBody.draft_json).toEqual(draftJson);
    expect(postBody.draft_md).toBe("Step one.");
    expect(postBody.draft_version).toBe(1);
    expect(postBody.status).toBe("drafted");

    const missingPost = await SELF.fetch(
      `http://localhost:5173/api/v1/blogs/${id}/posts/${crypto.randomUUID()}`,
      {
        headers,
      },
    );
    expect(missingPost.status).toBe(404);

    // Malformed draft_json (not a block array) is rejected, not stored.
    const badDraftJson = await SELF.fetch(
      `http://localhost:5173/api/v1/blogs/${id}/posts/${postId}`,
      {
        method: "PATCH",
        headers,
        body: JSON.stringify({ draft_json: { nested: "object" } }),
      },
    );
    expect(badDraftJson.status).toBeGreaterThanOrEqual(400);

    // First draft content promotes a planned post to drafting server-side…
    const secondPostId = postsBody.items[1].id;
    const secondPostDraftSessionId = crypto.randomUUID();
    await SELF.fetch(`http://localhost:5173/api/v1/blogs/${id}/posts/${secondPostId}`, {
      method: "PATCH",
      headers,
      body: JSON.stringify({
        draft_md: "Opening line.",
        draft_version: 0,
        draft_session_id: secondPostDraftSessionId,
        draft_sequence: 1,
      }),
    });
    const promoted = await SELF.fetch(
      `http://localhost:5173/api/v1/blogs/${id}/posts/${secondPostId}`,
      {
        headers,
      },
    );
    // biome-ignore lint/suspicious/noExplicitAny: response shape from our own API
    expect(((await promoted.json()) as any).status).toBe("drafting");

    // …but a draft-only save never downgrades an explicitly drafted post.
    await SELF.fetch(`http://localhost:5173/api/v1/blogs/${id}/posts/${secondPostId}`, {
      method: "PATCH",
      headers,
      body: JSON.stringify({ status: "drafted" }),
    });
    await SELF.fetch(`http://localhost:5173/api/v1/blogs/${id}/posts/${secondPostId}`, {
      method: "PATCH",
      headers,
      body: JSON.stringify({
        draft_md: "Opening line, revised.",
        draft_version: 1,
        draft_session_id: secondPostDraftSessionId,
        draft_sequence: 2,
      }),
    });
    const stillDrafted = await SELF.fetch(
      `http://localhost:5173/api/v1/blogs/${id}/posts/${secondPostId}`,
      {
        headers,
      },
    );
    // biome-ignore lint/suspicious/noExplicitAny: response shape from our own API
    expect(((await stillDrafted.json()) as any).status).toBe("drafted");

    const staleDraft = await SELF.fetch(`http://localhost:5173/api/v1/blogs/${id}/posts/${secondPostId}`, {
      method: "PATCH",
      headers,
      body: JSON.stringify({
        draft_md: "Delayed old line.",
        draft_version: 1,
        draft_session_id: crypto.randomUUID(),
        draft_sequence: 99,
      }),
    });
    expect(staleDraft.status).toBe(409);
    const afterStale = await SELF.fetch(`http://localhost:5173/api/v1/blogs/${id}/posts/${secondPostId}`, {
      headers,
    });
    // biome-ignore lint/suspicious/noExplicitAny: response shape from our own API
    const afterStaleBody = (await afterStale.json()) as any;
    expect(afterStaleBody.draft_md).toBe("Opening line, revised.");
    expect(afterStaleBody.draft_version).toBe(2);

    // Publishing requires an em_dash site + pub.fly.pm authentication first.
    const publishNoSite = await SELF.fetch(
      `http://localhost:5173/api/v1/blogs/${id}/posts/${postId}/publish`,
      {
        method: "POST",
        headers,
      },
    );
    expect(publishNoSite.status).toBe(400);

    const patchSite = await SELF.fetch(`http://localhost:5173/api/v1/blogs/${id}`, {
      method: "PATCH",
      headers,
      body: JSON.stringify({ emdash_site: "notes.example.com" }),
    });
    expect(patchSite.status).toBe(200);

    const publishNoToken = await SELF.fetch(
      `http://localhost:5173/api/v1/blogs/${id}/posts/${postId}/publish`,
      {
        method: "POST",
        headers,
      },
    );
    expect(publishNoToken.status).toBe(400);
    // biome-ignore lint/suspicious/noExplicitAny: response shape from our own API
    const publishErr = (await publishNoToken.json()) as any;
    expect(publishErr.error).toContain("pub.fly.pm");

    const del = await SELF.fetch(`http://localhost:5173/api/v1/blogs/${id}`, {
      method: "DELETE",
      headers,
    });
    expect(del.status).toBe(204);

    const list2 = await SELF.fetch("http://localhost:5173/api/v1/blogs", { headers });
    // biome-ignore lint/suspicious/noExplicitAny: response shape from our own API
    const items2 = (await list2.json()) as any;
    // biome-ignore lint/suspicious/noExplicitAny: row shape from our own API
    expect(items2.items.find((b: any) => b.id === id)).toBeFalsy();

    const deleted = await SELF.fetch("http://localhost:5173/api/v1/blogs/deleted/recent", {
      headers,
    });
    // biome-ignore lint/suspicious/noExplicitAny: response shape from our own API
    const deletedBody = (await deleted.json()) as any;
    // biome-ignore lint/suspicious/noExplicitAny: row shape from our own API
    expect(deletedBody.items.find((b: any) => b.id === id)).toBeTruthy();

    const restore = await SELF.fetch(`http://localhost:5173/api/v1/blogs/${id}/restore`, {
      method: "POST",
      headers,
    });
    expect(restore.status).toBe(200);

    const list3 = await SELF.fetch("http://localhost:5173/api/v1/blogs", { headers });
    // biome-ignore lint/suspicious/noExplicitAny: response shape from our own API
    const items3 = (await list3.json()) as any;
    // biome-ignore lint/suspicious/noExplicitAny: row shape from our own API
    expect(items3.items.find((b: any) => b.id === id)).toBeTruthy();
  });

  it("preserves an explicit status racing first-draft promotion and returns current versions", async () => {
    const cookie = await signUp();
    const headers = { "Content-Type": "application/json", cookie };
    const created = await SELF.fetch("http://localhost:5173/api/v1/blogs", {
      method: "POST",
      headers,
      body: JSON.stringify(blogPayload({ title: "Concurrent Notes" })),
    });
    expect(created.status).toBe(201);
    // biome-ignore lint/suspicious/noExplicitAny: response shape from our own API
    const { id } = (await created.json()) as any;

    const planned = await SELF.fetch(`http://localhost:5173/api/v1/blogs/${id}/plan`, {
      method: "POST",
      headers,
      body: JSON.stringify({ structure: "single-tutorial", planned_posts: 1 }),
    });
    expect(planned.status).toBe(200);
    const posts = await SELF.fetch(`http://localhost:5173/api/v1/blogs/${id}/posts`, { headers });
    // biome-ignore lint/suspicious/noExplicitAny: response shape from our own API
    const postsBody = (await posts.json()) as any;
    const postId = postsBody.items[0].id;

    const [explicitStatus, firstDraft] = await Promise.all([
      SELF.fetch(`http://localhost:5173/api/v1/blogs/${id}/posts/${postId}`, {
        method: "PATCH",
        headers,
        body: JSON.stringify({ status: "drafted" }),
      }),
      SELF.fetch(`http://localhost:5173/api/v1/blogs/${id}/posts/${postId}`, {
        method: "PATCH",
        headers,
        body: JSON.stringify({
          draft_md: "A concurrently saved opening.",
          draft_version: 0,
          draft_session_id: crypto.randomUUID(),
          draft_sequence: 1,
        }),
      }),
    ]);
    expect(explicitStatus.status).toBe(200);
    expect(firstDraft.status).toBe(200);
    // biome-ignore lint/suspicious/noExplicitAny: response shape from our own API
    expect(((await firstDraft.json()) as any).draft_version).toBe(1);

    const afterRace = await SELF.fetch(`http://localhost:5173/api/v1/blogs/${id}/posts/${postId}`, { headers });
    // biome-ignore lint/suspicious/noExplicitAny: response shape from our own API
    const afterRaceBody = (await afterRace.json()) as any;
    expect(afterRaceBody.status).toBe("drafted");
    expect(afterRaceBody.draft_version).toBe(1);

    const metadataPatch = await SELF.fetch(`http://localhost:5173/api/v1/blogs/${id}/posts/${postId}`, {
      method: "PATCH",
      headers,
      body: JSON.stringify({ title: "Concurrent Notes, Revised" }),
    });
    expect(metadataPatch.status).toBe(200);
    // biome-ignore lint/suspicious/noExplicitAny: response shape from our own API
    expect(((await metadataPatch.json()) as any).draft_version).toBe(1);
  });

  it("requires at least one voice sample", async () => {
    const cookie = await signUp();
    const headers = { "Content-Type": "application/json", cookie };
    const res = await SELF.fetch("http://localhost:5173/api/v1/blogs", {
      method: "POST",
      headers,
      body: JSON.stringify(blogPayload({ voice_links: [], voice_uploads: [] })),
    });
    expect(res.status).toBe(400);
  });

  it("enforces the serialized fiction planning threshold", async () => {
    const cookie = await signUp();
    const headers = { "Content-Type": "application/json", cookie };
    const created = await SELF.fetch("http://localhost:5173/api/v1/blogs", {
      method: "POST",
      headers,
      body: JSON.stringify(
        blogPayload({ format: "serialized-fiction", title: "The Drift Archive" }),
      ),
    });
    expect(created.status).toBe(201);
    // biome-ignore lint/suspicious/noExplicitAny: response shape from our own API
    const { id } = (await created.json()) as any;

    const tooFew = await SELF.fetch(`http://localhost:5173/api/v1/blogs/${id}/plan`, {
      method: "POST",
      headers,
      body: JSON.stringify({ structure: "hero-journey", planned_posts: 3 }),
    });
    expect(tooFew.status).toBe(400);
    // biome-ignore lint/suspicious/noExplicitAny: response shape from our own API
    const err = (await tooFew.json()) as any;
    expect(err.error).toContain("at least 8");

    const enough = await SELF.fetch(`http://localhost:5173/api/v1/blogs/${id}/plan`, {
      method: "POST",
      headers,
      body: JSON.stringify({ structure: "hero-journey", planned_posts: 8 }),
    });
    expect(enough.status).toBe(200);

    const posts = await SELF.fetch(`http://localhost:5173/api/v1/blogs/${id}/posts`, { headers });
    // biome-ignore lint/suspicious/noExplicitAny: response shape from our own API
    const postsBody = (await posts.json()) as any;
    expect(postsBody.items).toHaveLength(8);
    // Framework beats pre-title the planned posts (12 beats grouped onto 8).
    expect(postsBody.items[0].title).toBe("Ordinary World");
    expect(postsBody.items[1].title).toBe("Call to Adventure · Refusal");
    expect(postsBody.items[0].summary).toContain("normal life");
  });

  it("manages the pub.fly.pm token at account level", async () => {
    const cookie = await signUp();
    const headers = { "Content-Type": "application/json", cookie };

    const before = await SELF.fetch("http://localhost:5173/api/v1/account/emdash-token", {
      headers,
    });
    // biome-ignore lint/suspicious/noExplicitAny: response shape from our own API
    expect(((await before.json()) as any).configured).toBe(false);

    const put = await SELF.fetch("http://localhost:5173/api/v1/account/emdash-token", {
      method: "PUT",
      headers,
      body: JSON.stringify({ token: "pubfly-test-token-123" }),
    });
    expect(put.status).toBe(200);

    const after = await SELF.fetch("http://localhost:5173/api/v1/account/emdash-token", {
      headers,
    });
    // biome-ignore lint/suspicious/noExplicitAny: response shape from our own API
    expect(((await after.json()) as any).configured).toBe(true);
  });
});
