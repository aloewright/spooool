import { SELF, env } from "cloudflare:test";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { aiUsageCostCents, todayIso } from "../../apps/web/src/lib/budget";

type ResourceKind = "chapter" | "blog-post" | "script-scene";

type Fixture = {
  cookie: string;
  userId: string;
  resourceIds: Record<ResourceKind, string>;
  parentIds: Record<ResourceKind, string>;
};

type RevisionResponse = {
  revision: {
    id: string;
    before_md: string;
    after_md: string;
    llm_response: {
      route: string;
      tokens_in: number;
      tokens_out: number;
    };
  };
};

const gatewayOrigin = "https://gateway.test";
const mutableEnv = env as typeof env & {
  AI_GATEWAY_BASE_URL: string;
  AI_GATEWAY_TOKEN: string;
};
let expectedGatewayFragments: string[] = [];
let gatewayStatus = 200;
let gatewayCalls = 0;

beforeEach(() => {
  mutableEnv.AI_GATEWAY_BASE_URL = gatewayOrigin;
  mutableEnv.AI_GATEWAY_TOKEN = "test-token";
  expectedGatewayFragments = [];
  gatewayStatus = 200;
  gatewayCalls = 0;
  vi.spyOn(globalThis, "fetch").mockImplementation(async (input, init) => {
    const outbound = new Request(input, init);
    const url = new URL(outbound.url);
    if (
      outbound.method !== "POST" ||
      url.origin !== gatewayOrigin ||
      url.pathname !== "/chat/completions"
    ) {
      throw new Error(`No outbound mock for ${outbound.method} ${outbound.url}`);
    }
    gatewayCalls += 1;

    const request = JSON.parse(await outbound.text()) as {
      messages?: Array<{ content?: string }>;
    };
    const prompt = request.messages?.map((message) => message.content ?? "").join("\n") ?? "";
    if (!expectedGatewayFragments.every((fragment) => prompt.includes(fragment))) {
      throw new Error("Gateway request omitted authoritative resource context");
    }

    if (gatewayStatus !== 200) {
      return new Response("gateway unavailable", { status: gatewayStatus });
    }
    return new Response(
      JSON.stringify({
        choices: [{ message: { content: "Gateway replacement." } }],
        usage: { prompt_tokens: 11, completion_tokens: 3 },
      }),
      { headers: { "content-type": "application/json" } },
    );
  });
});

afterEach(() => {
  mutableEnv.AI_GATEWAY_BASE_URL = "";
  mutableEnv.AI_GATEWAY_TOKEN = "";
  vi.restoreAllMocks();
});

const payload = (resource_kind: ResourceKind, resource_id: string) => ({
  resource_kind,
  resource_id,
  command: "proofread",
  scope: "document",
  target_md: "Original prose.",
  context_md: "Original prose.",
});

async function signUp(plan: "free" | "pro" = "pro") {
  const email = `editor-ai-${crypto.randomUUID()}@x.test`;
  const response = await SELF.fetch("http://x/api/auth/sign-up/email", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      email,
      password: "correct-horse-battery-staple",
      name: "Editor AI Test",
      plan,
    }),
  });
  expect(response.status).toBe(200);

  const user = await env.DB.prepare("SELECT id, plan FROM users WHERE email = ?")
    .bind(email)
    .first<{ id: string; plan: string }>();
  expect(user?.plan).toBe(plan);
  if (!user) throw new Error("signed-up user was not persisted");

  return {
    cookie: response.headers.get("set-cookie") ?? "",
    userId: user.id,
  };
}

async function createFixture(plan: "free" | "pro" = "pro"): Promise<Fixture> {
  const { cookie, userId } = await signUp(plan);
  const voiceId = crypto.randomUUID();
  const projectId = crypto.randomUUID();
  const chapterId = crypto.randomUUID();
  const blogId = crypto.randomUUID();
  const blogPostId = crypto.randomUUID();
  const scriptId = crypto.randomUUID();
  const scriptSceneId = crypto.randomUUID();

  await env.DB.batch([
    env.DB.prepare(
      "INSERT INTO voices (id, user_id, name, source, profile_json) VALUES (?, ?, ?, ?, ?)",
    ).bind(
      voiceId,
      userId,
      "Direct voice",
      "custom",
      JSON.stringify({ cadence: "short and direct" }),
    ),
    env.DB.prepare(
      "INSERT INTO projects (id, user_id, title, type, voice_id) VALUES (?, ?, ?, ?, ?)",
    ).bind(projectId, userId, "Quiet Operator", "nonfiction", voiceId),
    env.DB.prepare(
      "INSERT INTO chapters (id, project_id, ordinal, title, summary) VALUES (?, ?, ?, ?, ?)",
    ).bind(
      chapterId,
      projectId,
      1,
      "The Cost of Staying Stuck",
      "Show why reactive work remains expensive.",
    ),
    env.DB.prepare(
      "INSERT INTO blogs (id, user_id, title, format, description, voice_profile_md, rules_do_json, rules_dont_json) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
    ).bind(
      blogId,
      userId,
      "Field Notes",
      "how-to",
      "Practical systems for focused work.",
      "Direct and practical.",
      JSON.stringify(["Cite primary sources"]),
      JSON.stringify(["No filler"]),
    ),
    env.DB.prepare(
      "INSERT INTO blog_posts (id, blog_id, ordinal, title, summary) VALUES (?, ?, ?, ?, ?)",
    ).bind(blogPostId, blogId, 1, "Build a Calm Queue", "Explain a reliable prioritization loop."),
    env.DB.prepare(
      "INSERT INTO scripts (id, user_id, title, format, logline, genre) VALUES (?, ?, ?, ?, ?, ?)",
    ).bind(
      scriptId,
      userId,
      "Final Approach",
      "feature",
      "A controller guides a damaged plane through a storm.",
      "Drama",
    ),
    env.DB.prepare(
      "INSERT INTO script_scenes (id, script_id, ordinal, title, summary) VALUES (?, ?, ?, ?, ?)",
    ).bind(scriptSceneId, scriptId, 3, "Storm Watch", "The first warning reaches the tower."),
  ]);

  return {
    cookie,
    userId,
    resourceIds: {
      chapter: chapterId,
      "blog-post": blogPostId,
      "script-scene": scriptSceneId,
    },
    parentIds: {
      chapter: projectId,
      "blog-post": blogId,
      "script-scene": scriptId,
    },
  };
}

async function requestEditorAi(cookie: string, body: unknown, headers: HeadersInit = {}) {
  return requestEditorAiRaw(cookie, JSON.stringify(body), headers);
}

async function requestEditorAiRaw(cookie: string, body: BodyInit, headers: HeadersInit = {}) {
  return SELF.fetch("http://x/api/v1/editor/ai", {
    method: "POST",
    headers: { "Content-Type": "application/json", cookie, ...headers },
    body,
  });
}

function draftPath(fixture: Fixture, resourceKind: ResourceKind): string {
  switch (resourceKind) {
    case "chapter":
      return `/api/v1/chapters/${fixture.resourceIds.chapter}`;
    case "blog-post":
      return `/api/v1/blogs/${fixture.parentIds["blog-post"]}/posts/${fixture.resourceIds["blog-post"]}`;
    case "script-scene":
      return `/api/v1/scripts/${fixture.parentIds["script-scene"]}/scenes/${fixture.resourceIds["script-scene"]}`;
  }
}

function draftTable(resourceKind: ResourceKind): "chapters" | "blog_posts" | "script_scenes" {
  switch (resourceKind) {
    case "chapter":
      return "chapters";
    case "blog-post":
      return "blog_posts";
    case "script-scene":
      return "script_scenes";
  }
}

async function requestDraftPatch(
  fixture: Fixture,
  resourceKind: ResourceKind,
  body: Record<string, unknown>,
) {
  return SELF.fetch(`http://x${draftPath(fixture, resourceKind)}`, {
    method: "PATCH",
    headers: { "Content-Type": "application/json", cookie: fixture.cookie },
    body: JSON.stringify(body),
  });
}

async function draftState(resourceKind: ResourceKind, resourceId: string) {
  return env.DB.prepare(
    `SELECT draft_md, draft_version, draft_session_id, draft_sequence FROM ${draftTable(resourceKind)} WHERE id = ?`,
  )
    .bind(resourceId)
    .first<{
      draft_md: string;
      draft_version: number;
      draft_session_id: string | null;
      draft_sequence: number;
    }>();
}

function streamedBody(value: string): ReadableStream<Uint8Array> {
  const bytes = new TextEncoder().encode(value);
  let offset = 0;
  return new ReadableStream({
    pull(controller) {
      if (offset >= bytes.byteLength) {
        controller.close();
        return;
      }
      const nextOffset = Math.min(offset + 64_000, bytes.byteLength);
      controller.enqueue(bytes.slice(offset, nextOffset));
      offset = nextOffset;
    },
  });
}

async function revisionFor(targetId: string) {
  return env.DB.prepare(
    "SELECT target_table, target_id, before_md, after_md, llm_response FROM revisions WHERE target_id = ?",
  )
    .bind(targetId)
    .first<{
      target_table: string;
      target_id: string;
      before_md: string;
      after_md: string;
      llm_response: string;
    }>();
}

const successCases = [
  {
    kind: "chapter" as const,
    targetTable: "chapters",
    context: [
      "Project title: Quiet Operator",
      'Voice profile JSON: {\\"cadence\\":\\"short and direct\\"}',
    ],
  },
  {
    kind: "blog-post" as const,
    targetTable: "blog_posts",
    context: [
      "Blog title: Field Notes",
      "Do rules: Cite primary sources",
      "Don't rules: No filler",
    ],
  },
  {
    kind: "script-scene" as const,
    targetTable: "script_scenes",
    context: ["Script title: Final Approach", "Scene title: Storm Watch", "Scene ordinal: 3"],
  },
];

describe("editor AI", () => {
  it.each(successCases)(
    "creates a $targetTable revision from authoritative $kind context",
    async ({ kind, targetTable, context }) => {
      const fixture = await createFixture();
      expectedGatewayFragments = context;

      const response = await requestEditorAi(
        fixture.cookie,
        payload(kind, fixture.resourceIds[kind]),
      );
      expect(response.status).toBe(200);
      const body = (await response.json()) as RevisionResponse;
      expect(body.revision).toMatchObject({
        before_md: "Original prose.",
        after_md: "Gateway replacement.",
        llm_response: {
          route: "dynamic/text_gen",
          tokens_in: 11,
          tokens_out: 3,
        },
      });

      const stored = await revisionFor(fixture.resourceIds[kind]);
      expect(stored).toMatchObject({
        target_table: targetTable,
        target_id: fixture.resourceIds[kind],
        before_md: "Original prose.",
        after_md: "Gateway replacement.",
      });
      expect(JSON.parse(stored?.llm_response ?? "null")).toEqual(body.revision.llm_response);
    },
  );

  it("requires authentication", async () => {
    const response = await requestEditorAi("", payload("chapter", crypto.randomUUID()));
    expect(response.status).toBe(401);
  });

  it("returns the same not-found response for another user's resources", async () => {
    const owner = await createFixture();
    const other = await signUp();

    for (const kind of ["chapter", "blog-post", "script-scene"] as const) {
      const response = await requestEditorAi(other.cookie, payload(kind, owner.resourceIds[kind]));
      expect(response.status).toBe(404);
      expect(await response.json()).toEqual({ error: "not found" });
    }
  }, 15_000);

  it("returns the same not-found response when a parent is deleted", async () => {
    const fixture = await createFixture();
    await env.DB.batch([
      env.DB.prepare("UPDATE projects SET deleted_at = unixepoch() WHERE id = ?").bind(
        fixture.parentIds.chapter,
      ),
      env.DB.prepare("UPDATE blogs SET deleted_at = unixepoch() WHERE id = ?").bind(
        fixture.parentIds["blog-post"],
      ),
      env.DB.prepare("UPDATE scripts SET deleted_at = unixepoch() WHERE id = ?").bind(
        fixture.parentIds["script-scene"],
      ),
    ]);

    for (const kind of ["chapter", "blog-post", "script-scene"] as const) {
      const response = await requestEditorAi(
        fixture.cookie,
        payload(kind, fixture.resourceIds[kind]),
      );
      expect(response.status).toBe(404);
      expect(await response.json()).toEqual({ error: "not found" });
    }
  });

  it("returns the same not-found response for missing resources", async () => {
    const fixture = await createFixture();

    for (const kind of ["chapter", "blog-post", "script-scene"] as const) {
      const response = await requestEditorAi(fixture.cookie, payload(kind, crypto.randomUUID()));
      expect(response.status).toBe(404);
      expect(await response.json()).toEqual({ error: "not found" });
    }
  });

  it("rejects rewrite without instructions before generating or recording a revision", async () => {
    const fixture = await createFixture();
    const resourceId = fixture.resourceIds.chapter;
    const response = await requestEditorAi(fixture.cookie, {
      ...payload("chapter", resourceId),
      command: "rewrite",
    });

    expect(response.status).toBe(400);
    expect(await revisionFor(resourceId)).toBeNull();
  });

  it("does not record a revision when the gateway fails", async () => {
    const fixture = await createFixture();
    const resourceId = fixture.resourceIds.chapter;
    gatewayStatus = 503;

    const response = await requestEditorAi(fixture.cookie, payload("chapter", resourceId));
    expect(response.status).toBe(500);
    expect(await revisionFor(resourceId)).toBeNull();
    expect(
      await env.KV.get(`budget:${fixture.userId}:${new Date().toISOString().slice(0, 10)}`),
    ).toBeNull();
  });

  it("does not charge the editor route when gateway configuration is missing", async () => {
    const fixture = await createFixture();
    const resourceId = fixture.resourceIds.chapter;
    mutableEnv.AI_GATEWAY_BASE_URL = "";
    mutableEnv.AI_GATEWAY_TOKEN = "";

    const response = await requestEditorAi(fixture.cookie, payload("chapter", resourceId));

    expect(response.status).toBe(500);
    expect(gatewayCalls).toBe(0);
    expect(await revisionFor(resourceId)).toBeNull();
    expect(await env.KV.get(`budget:${fixture.userId}:${todayIso()}`)).toBeNull();
  });

  it("records hosted usage even when revision persistence fails afterward", async () => {
    const fixture = await createFixture();
    const resourceId = fixture.resourceIds.chapter;
    const budgetKey = `budget:${fixture.userId}:${todayIso()}`;
    await env.DB.prepare(`
      CREATE TRIGGER fail_editor_ai_revision
      BEFORE INSERT ON revisions
      BEGIN
        SELECT RAISE(ABORT, 'revision persistence failed');
      END
    `).run();

    try {
      const response = await requestEditorAi(fixture.cookie, payload("chapter", resourceId));
      expect(response.status).toBe(500);
      expect(await env.KV.get(budgetKey)).toBe("1");
      expect(await revisionFor(resourceId)).toBeNull();
    } finally {
      await env.DB.prepare("DROP TRIGGER IF EXISTS fail_editor_ai_revision").run();
    }
  });

  it("records successful token usage and rejects the next call at the free-plan cap", async () => {
    const fixture = await createFixture("free");
    const budgetKey = `budget:${fixture.userId}:${new Date().toISOString().slice(0, 10)}`;
    await env.KV.put(budgetKey, "999");

    const first = await requestEditorAi(
      fixture.cookie,
      payload("chapter", fixture.resourceIds.chapter),
    );
    expect(first.status).toBe(200);
    expect(await env.KV.get(budgetKey)).toBe("1000");

    const second = await requestEditorAi(
      fixture.cookie,
      payload("chapter", fixture.resourceIds.chapter),
    );
    expect(second.status).toBe(402);
    expect(gatewayCalls).toBe(1);
  });

  it("records successful retained chapter revision usage", async () => {
    const fixture = await createFixture("free");
    const budgetKey = `budget:${fixture.userId}:${new Date().toISOString().slice(0, 10)}`;
    await env.KV.put(budgetKey, "999");

    const first = await SELF.fetch(
      `http://x/api/v1/chapters/${fixture.resourceIds.chapter}/revise`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json", cookie: fixture.cookie },
        body: JSON.stringify({
          action: "fix-grammar",
          text: "This are selected prose.",
          context_md: "This are selected prose.",
        }),
      },
    );
    expect(first.status).toBe(200);
    expect(await env.KV.get(budgetKey)).toBe("1000");

    const second = await SELF.fetch(
      `http://x/api/v1/chapters/${fixture.resourceIds.chapter}/revise`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json", cookie: fixture.cookie },
        body: JSON.stringify({
          action: "fix-grammar",
          text: "This are selected prose.",
          context_md: "This are selected prose.",
        }),
      },
    );
    expect(second.status).toBe(402);
    expect(gatewayCalls).toBe(1);
  });

  it("returns 402 when the free-plan daily budget is exhausted", async () => {
    const fixture = await createFixture("free");
    const resourceId = fixture.resourceIds.chapter;
    await env.KV.put(`budget:${fixture.userId}:${new Date().toISOString().slice(0, 10)}`, "1000");

    const response = await requestEditorAi(fixture.cookie, payload("chapter", resourceId));
    expect(response.status).toBe(402);
    expect(await revisionFor(resourceId)).toBeNull();
  });

  it("also enforces the daily budget on retained chapter inline revisions", async () => {
    const fixture = await createFixture("free");
    const resourceId = fixture.resourceIds.chapter;
    await env.KV.put(`budget:${fixture.userId}:${new Date().toISOString().slice(0, 10)}`, "1000");

    const response = await SELF.fetch(`http://x/api/v1/chapters/${resourceId}/revise`, {
      method: "POST",
      headers: { "Content-Type": "application/json", cookie: fixture.cookie },
      body: JSON.stringify({
        action: "fix-grammar",
        text: "This are selected prose.",
        context_md: "This are selected prose.",
      }),
    });

    expect(response.status).toBe(402);
    expect(await revisionFor(resourceId)).toBeNull();
  });

  it("allows an exhausted user to use the zero-cost local chapter revision fallback", async () => {
    const fixture = await createFixture("free");
    const resourceId = fixture.resourceIds.chapter;
    const budgetKey = `budget:${fixture.userId}:${todayIso()}`;
    await env.KV.put(budgetKey, "1000");
    mutableEnv.AI_GATEWAY_BASE_URL = "";
    mutableEnv.AI_GATEWAY_TOKEN = "";

    const response = await SELF.fetch(`http://x/api/v1/chapters/${resourceId}/revise`, {
      method: "POST",
      headers: { "Content-Type": "application/json", cookie: fixture.cookie },
      body: JSON.stringify({
        action: "fix-grammar",
        text: "This are selected prose.",
        context_md: "This are selected prose.",
      }),
    });

    expect(response.status).toBe(200);
    const body = (await response.json()) as RevisionResponse;
    expect(body.revision.llm_response.route).toBe("deterministic/local");
    expect(await env.KV.get(budgetKey)).toBe("1000");
    expect(gatewayCalls).toBe(0);
  });

  it("records editor-ai usage after a successful request and blocks the next call at cap", async () => {
    const fixture = await createFixture("free");
    const resourceId = fixture.resourceIds.chapter;
    const budgetKey = `budget:${fixture.userId}:${todayIso()}`;
    const usage = aiUsageCostCents({
      route: "dynamic/text_gen",
      tokens_in: 11,
      tokens_out: 3,
    });
    await env.KV.put(budgetKey, String(1000 - usage));

    const first = await requestEditorAi(fixture.cookie, payload("chapter", resourceId));
    expect(first.status).toBe(200);
    expect(await env.KV.get(budgetKey)).toBe("1000");

    const second = await requestEditorAi(fixture.cookie, payload("chapter", resourceId));
    expect(second.status).toBe(402);
  });

  it("records retained chapter inline revision usage after a successful request", async () => {
    const fixture = await createFixture("free");
    const resourceId = fixture.resourceIds.chapter;
    const budgetKey = `budget:${fixture.userId}:${todayIso()}`;
    const usage = aiUsageCostCents({
      route: "dynamic/text_gen",
      tokens_in: 11,
      tokens_out: 3,
    });
    await env.KV.put(budgetKey, String(1000 - usage));

    const first = await SELF.fetch(`http://x/api/v1/chapters/${resourceId}/revise`, {
      method: "POST",
      headers: { "Content-Type": "application/json", cookie: fixture.cookie },
      body: JSON.stringify({
        action: "fix-grammar",
        text: "This are selected prose.",
        context_md: "This are selected prose.",
      }),
    });

    expect(first.status).toBe(200);
    expect(await env.KV.get(budgetKey)).toBe("1000");

    const second = await SELF.fetch(`http://x/api/v1/chapters/${resourceId}/revise`, {
      method: "POST",
      headers: { "Content-Type": "application/json", cookie: fixture.cookie },
      body: JSON.stringify({
        action: "fix-grammar",
        text: "This are selected prose.",
        context_md: "This are selected prose.",
      }),
    });
    expect(second.status).toBe(402);
  });

  it.each([["chapter" as const], ["blog-post" as const], ["script-scene" as const]])(
    "rejects draft saves without concurrency fields for %s",
    async (resourceKind) => {
      const fixture = await createFixture();
      const response = await requestDraftPatch(fixture, resourceKind, {
        draft_md: "Unversioned draft save",
      });

      expect(response.status).toBe(400);
    },
  );

  it.each([["chapter" as const], ["blog-post" as const], ["script-scene" as const]])(
    "keeps same-session sequence 2 when it arrives before sequence 1 for %s",
    async (resourceKind) => {
      const fixture = await createFixture();
      const resourceId = fixture.resourceIds[resourceKind];
      const draftSessionId = crypto.randomUUID();

      const newest = await requestDraftPatch(fixture, resourceKind, {
        draft_md: "Newest draft wins.",
        draft_version: 0,
        draft_session_id: draftSessionId,
        draft_sequence: 2,
      });
      expect(newest.status).toBe(200);
      await expect(newest.json()).resolves.toMatchObject({ draft_version: 1 });

      const stale = await requestDraftPatch(fixture, resourceKind, {
        draft_md: "Older draft should be rejected.",
        // Even knowing the fresh server version must not let an older
        // same-session sequence roll the draft back.
        draft_version: 1,
        draft_session_id: draftSessionId,
        draft_sequence: 1,
      });
      expect(stale.status).toBe(409);
      await expect(stale.json()).resolves.toMatchObject({
        error: "stale draft",
        draft_version: 1,
      });

      await expect(draftState(resourceKind, resourceId)).resolves.toEqual({
        draft_md: "Newest draft wins.",
        draft_version: 1,
        draft_session_id: draftSessionId,
        draft_sequence: 2,
      });
    },
  );

  it.each([["chapter" as const], ["blog-post" as const], ["script-scene" as const]])(
    "accepts same-session sequences 1 then 2 from the same expected base for %s",
    async (resourceKind) => {
      const fixture = await createFixture();
      const resourceId = fixture.resourceIds[resourceKind];
      const draftSessionId = crypto.randomUUID();

      const first = await requestDraftPatch(fixture, resourceKind, {
        draft_md: "First draft.",
        draft_version: 0,
        draft_session_id: draftSessionId,
        draft_sequence: 1,
      });
      expect(first.status).toBe(200);
      await expect(first.json()).resolves.toMatchObject({ draft_version: 1 });

      const second = await requestDraftPatch(fixture, resourceKind, {
        draft_md: "Second draft wins.",
        draft_version: 0,
        draft_session_id: draftSessionId,
        draft_sequence: 2,
      });
      expect(second.status).toBe(200);
      await expect(second.json()).resolves.toMatchObject({ draft_version: 2 });

      await expect(draftState(resourceKind, resourceId)).resolves.toEqual({
        draft_md: "Second draft wins.",
        draft_version: 2,
        draft_session_id: draftSessionId,
        draft_sequence: 2,
      });
    },
  );

  it.each([["chapter" as const], ["blog-post" as const], ["script-scene" as const]])(
    "rejects a different stale session even with a high sequence for %s",
    async (resourceKind) => {
      const fixture = await createFixture();
      const resourceId = fixture.resourceIds[resourceKind];
      const currentSessionId = crypto.randomUUID();

      const current = await requestDraftPatch(fixture, resourceKind, {
        draft_md: "Current session draft.",
        draft_version: 0,
        draft_session_id: currentSessionId,
        draft_sequence: 1,
      });
      expect(current.status).toBe(200);

      const staleSessionId = crypto.randomUUID();
      const stale = await requestDraftPatch(fixture, resourceKind, {
        draft_md: "Stale other-tab draft.",
        draft_version: 0,
        draft_session_id: staleSessionId,
        draft_sequence: 99_999,
      });
      expect(stale.status).toBe(409);
      await expect(stale.json()).resolves.toMatchObject({
        error: "stale draft",
        draft_version: 1,
      });

      const repeatedStale = await requestDraftPatch(fixture, resourceKind, {
        draft_md: "Stale tab retries with a higher sequence.",
        draft_version: 0,
        draft_session_id: staleSessionId,
        draft_sequence: 100_000,
      });
      expect(repeatedStale.status).toBe(409);

      await expect(draftState(resourceKind, resourceId)).resolves.toEqual({
        draft_md: "Current session draft.",
        draft_version: 1,
        draft_session_id: currentSessionId,
        draft_sequence: 1,
      });
    },
  );

  it("rejects a declared request body larger than the route cap", async () => {
    const fixture = await createFixture();
    const resourceId = fixture.resourceIds.chapter;
    const response = await requestEditorAi(fixture.cookie, payload("chapter", resourceId), {
      "Content-Length": "310001",
    });

    expect(response.status).toBe(413);
    expect(gatewayCalls).toBe(0);
    expect(await revisionFor(resourceId)).toBeNull();
  });

  it.each([
    ["missing", {}],
    ["understated", { "Content-Length": "100" }],
  ])(
    "rejects an oversized body with %s Content-Length before generation",
    async (_description, headers) => {
      const fixture = await createFixture();
      const resourceId = fixture.resourceIds.chapter;
      const body = streamedBody(
        JSON.stringify({
          ...payload("chapter", resourceId),
          oversized_unknown: "x".repeat(310_000),
        }),
      );

      const response = await requestEditorAiRaw(fixture.cookie, body, headers);

      expect(response.status).toBe(413);
      expect(gatewayCalls).toBe(0);
      expect(await revisionFor(resourceId)).toBeNull();
    },
  );

  it("rejects a small request with an unknown key before generation", async () => {
    const fixture = await createFixture();
    const resourceId = fixture.resourceIds.chapter;

    const response = await requestEditorAi(fixture.cookie, {
      ...payload("chapter", resourceId),
      unknown_key: "must not be silently discarded",
    });

    expect(response.status).toBe(400);
    expect(gatewayCalls).toBe(0);
    expect(await revisionFor(resourceId)).toBeNull();
  });
});
