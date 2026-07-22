import { SELF, env } from "cloudflare:test";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  aiRequestFingerprint,
  aiReservationCostCents,
  aiUsageCostCents,
  reserveAiBudgetRequest,
  todayIso,
} from "../../apps/web/src/lib/budget";
import { buildEditorCommandMessages } from "../../apps/web/src/skills/editor-command";

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
  const password = "correct-horse-battery-staple";
  const response = await SELF.fetch("http://localhost:5173/api/auth/sign-up/email", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      email,
      password,
      name: "Editor AI Test",
    }),
  });
  expect(response.status).toBe(200);

  await env.DB.prepare("UPDATE users SET plan = ? WHERE email = ?").bind(plan, email).run();

  const user = await env.DB.prepare("SELECT id, plan FROM users WHERE email = ?")
    .bind(email)
    .first<{ id: string; plan: string }>();
  expect(user?.plan).toBe(plan);
  if (!user) throw new Error("signed-up user was not persisted");

  // Create a fresh session after the server-side plan assignment so the
  // authenticated user reflects the persisted plan without trusting sign-up
  // input for privileged fields.
  const signIn = await SELF.fetch("http://localhost:5173/api/auth/sign-in/email", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ email, password }),
  });
  expect(signIn.status).toBe(200);

  return {
    cookie: signIn.headers.get("set-cookie") ?? "",
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
  return SELF.fetch("http://localhost:5173/api/v1/editor/ai", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      cookie,
      "Idempotency-Key": crypto.randomUUID(),
      ...headers,
    },
    body,
  });
}

async function requestInlineRevision(
  fixture: Fixture,
  body: Record<string, unknown> = {
    action: "fix-grammar",
    text: "This are selected prose.",
    context_md: "This are selected prose.",
  },
  headers: HeadersInit = {},
) {
  return SELF.fetch(`http://localhost:5173/api/v1/chapters/${fixture.resourceIds.chapter}/revise`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      cookie: fixture.cookie,
      "Idempotency-Key": crypto.randomUUID(),
      ...headers,
    },
    body: JSON.stringify(body),
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
  return SELF.fetch(`http://localhost:5173${draftPath(fixture, resourceKind)}`, {
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

async function budgetUsageCents(userId: string): Promise<number> {
  const row = await env.DB.prepare(
    `SELECT COALESCE(SUM(
      CASE
        WHEN status IN ('pending', 'generated') THEN reserved_cents
        WHEN status = 'succeeded' THEN COALESCE(actual_cents, reserved_cents)
        ELSE 0
      END
    ), 0) AS cents
    FROM ai_budget_requests
    WHERE user_id = ? AND usage_date = ? AND expires_at > unixepoch()`,
  )
    .bind(userId, todayIso())
    .first<{ cents: number }>();
  return row?.cents ?? 0;
}

async function seedBudgetUsage(userId: string, cents: number): Promise<void> {
  if (cents <= 0) return;
  await env.DB.prepare(
    `INSERT INTO ai_budget_requests (
      request_id, user_id, usage_date, fingerprint, route,
      reserved_cents, actual_cents, status, response_json, expires_at
    ) VALUES (?, ?, ?, ?, 'dynamic/text_gen', ?, ?, 'succeeded', '{}', unixepoch() + 93600)`,
  )
    .bind(crypto.randomUUID(), userId, todayIso(), crypto.randomUUID(), cents, cents)
    .run();
}

async function budgetRequest(requestId: string) {
  return env.DB.prepare(
    `SELECT usage_date, status, reserved_cents, actual_cents, revision_id, response_json
    FROM ai_budget_requests WHERE request_id = ?`,
  )
    .bind(requestId)
    .first<{
      usage_date: string;
      status: string;
      reserved_cents: number;
      actual_cents: number | null;
      revision_id: string | null;
      response_json: string | null;
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

  it("requires a UUID idempotency key before invoking the hosted editor provider", async () => {
    const fixture = await createFixture();
    const response = await requestEditorAi(
      fixture.cookie,
      payload("chapter", fixture.resourceIds.chapter),
      { "Idempotency-Key": "" },
    );

    expect(response.status).toBe(400);
    expect(gatewayCalls).toBe(0);
  });

  it("releases a failed provider reservation and safely retries the same key", async () => {
    const fixture = await createFixture();
    const resourceId = fixture.resourceIds.chapter;
    const requestId = crypto.randomUUID();
    gatewayStatus = 503;

    const failed = await requestEditorAi(fixture.cookie, payload("chapter", resourceId), {
      "Idempotency-Key": requestId,
    });
    expect(failed.status).toBe(500);
    expect(await budgetRequest(requestId)).toMatchObject({ status: "failed", actual_cents: 0 });
    expect(await budgetUsageCents(fixture.userId)).toBe(0);
    expect(await revisionFor(resourceId)).toBeNull();

    gatewayStatus = 200;
    const retried = await requestEditorAi(fixture.cookie, payload("chapter", resourceId), {
      "Idempotency-Key": requestId,
    });
    expect(retried.status).toBe(200);
    const retriedBody = (await retried.json()) as RevisionResponse;

    const replay = await requestEditorAi(fixture.cookie, payload("chapter", resourceId), {
      "Idempotency-Key": requestId,
    });
    expect(replay.status).toBe(200);
    await expect(replay.json()).resolves.toEqual(retriedBody);
    expect(gatewayCalls).toBe(2);
  });

  it("moves a failed retry into the current usage day", async () => {
    const fixture = await createFixture();
    const resourceId = fixture.resourceIds.chapter;
    const requestId = crypto.randomUUID();
    gatewayStatus = 503;

    const failed = await requestEditorAi(fixture.cookie, payload("chapter", resourceId), {
      "Idempotency-Key": requestId,
    });
    expect(failed.status).toBe(500);
    await env.DB.prepare("UPDATE ai_budget_requests SET usage_date = ? WHERE request_id = ?")
      .bind("2000-01-01", requestId)
      .run();

    gatewayStatus = 200;
    const retried = await requestEditorAi(fixture.cookie, payload("chapter", resourceId), {
      "Idempotency-Key": requestId,
    });
    expect(retried.status).toBe(200);
    expect(await budgetRequest(requestId)).toMatchObject({
      usage_date: todayIso(),
      status: "succeeded",
    });
    expect(await budgetUsageCents(fixture.userId)).toBe(1);
  });

  it("keeps a failed reservation released when its retry no longer fits the cap", async () => {
    const fixture = await createFixture("free");
    const resourceId = fixture.resourceIds.chapter;
    const requestId = crypto.randomUUID();
    gatewayStatus = 503;

    const failed = await requestEditorAi(fixture.cookie, payload("chapter", resourceId), {
      "Idempotency-Key": requestId,
    });
    expect(failed.status).toBe(500);
    await seedBudgetUsage(fixture.userId, 1_000);

    gatewayStatus = 200;
    const blockedRetry = await requestEditorAi(fixture.cookie, payload("chapter", resourceId), {
      "Idempotency-Key": requestId,
    });
    expect(blockedRetry.status).toBe(402);
    expect(await budgetRequest(requestId)).toMatchObject({ status: "failed", actual_cents: 0 });
    expect(gatewayCalls).toBe(1);
  });

  it("does not charge when gateway configuration is missing", async () => {
    const fixture = await createFixture();
    const resourceId = fixture.resourceIds.chapter;
    const requestId = crypto.randomUUID();
    mutableEnv.AI_GATEWAY_BASE_URL = "";
    mutableEnv.AI_GATEWAY_TOKEN = "";

    const response = await requestEditorAi(fixture.cookie, payload("chapter", resourceId), {
      "Idempotency-Key": requestId,
    });

    expect(response.status).toBe(500);
    expect(gatewayCalls).toBe(0);
    expect(await revisionFor(resourceId)).toBeNull();
    expect(await budgetRequest(requestId)).toMatchObject({ status: "failed" });
    expect(await budgetUsageCents(fixture.userId)).toBe(0);
  });

  it("finishes a staged provider result after settlement failure without calling twice", async () => {
    const fixture = await createFixture();
    const resourceId = fixture.resourceIds.chapter;
    const requestId = crypto.randomUUID();
    await env.DB.prepare(`
      CREATE TRIGGER fail_editor_ai_settlement
      BEFORE UPDATE OF status ON ai_budget_requests
      WHEN NEW.status = 'succeeded'
      BEGIN
        SELECT RAISE(ABORT, 'settlement failed');
      END
    `).run();

    let firstBody: RevisionResponse | null = null;
    try {
      const first = await requestEditorAi(fixture.cookie, payload("chapter", resourceId), {
        "Idempotency-Key": requestId,
      });
      expect(first.status).toBe(500);
      const staged = await budgetRequest(requestId);
      expect(staged).toMatchObject({ status: "generated", actual_cents: 1 });
      firstBody = JSON.parse(staged?.response_json ?? "null") as RevisionResponse;
      expect(firstBody.revision.after_md).toBe("Gateway replacement.");
      expect(await revisionFor(resourceId)).toBeNull();
      expect(gatewayCalls).toBe(1);
    } finally {
      await env.DB.prepare("DROP TRIGGER IF EXISTS fail_editor_ai_settlement").run();
    }

    const retry = await requestEditorAi(fixture.cookie, payload("chapter", resourceId), {
      "Idempotency-Key": requestId,
    });
    expect(retry.status).toBe(200);
    await expect(retry.json()).resolves.toEqual(firstBody);
    expect(gatewayCalls).toBe(1);
    expect(await budgetRequest(requestId)).toMatchObject({ status: "succeeded", actual_cents: 1 });
    expect(await revisionFor(resourceId)).toMatchObject({ after_md: "Gateway replacement." });
  });

  it("returns retryable pending for a duplicate of an in-flight reservation", async () => {
    const fixture = await createFixture("free");
    const request = payload("chapter", fixture.resourceIds.chapter);
    const requestId = crypto.randomUUID();
    const reservation = await reserveAiBudgetRequest(env.DB, {
      requestId,
      userId: fixture.userId,
      fingerprint: await aiRequestFingerprint(["editor-ai", request]),
      route: "dynamic/text_gen",
      reservedCents: 20,
      capCents: 1_000,
    });
    expect(reservation.state).toBe("acquired");

    const pending = await requestEditorAi(fixture.cookie, request, {
      "Idempotency-Key": requestId,
    });
    expect(pending.status).toBe(409);
    expect(pending.headers.get("retry-after")).toBe("1");
    await expect(pending.json()).resolves.toMatchObject({ retryable: true });
    expect(gatewayCalls).toBe(0);
  });

  it("rejects reuse of an idempotency key with a different request fingerprint", async () => {
    const fixture = await createFixture();
    const requestId = crypto.randomUUID();
    const original = payload("chapter", fixture.resourceIds.chapter);
    const first = await requestEditorAi(fixture.cookie, original, {
      "Idempotency-Key": requestId,
    });
    expect(first.status).toBe(200);

    const conflict = await requestEditorAi(
      fixture.cookie,
      { ...original, target_md: "Different prose.", context_md: "Different prose." },
      { "Idempotency-Key": requestId },
    );
    expect(conflict.status).toBe(409);
    expect(gatewayCalls).toBe(1);
  });

  it("atomically admits only one concurrent request at the remaining free-plan cap", async () => {
    const fixture = await createFixture("free");
    const request = payload("chapter", fixture.resourceIds.chapter);
    const reservation = aiReservationCostCents(
      "dynamic/text_gen",
      JSON.stringify(
        buildEditorCommandMessages({
          request,
          context: {
            kind: "chapter",
            projectTitle: "Quiet Operator",
            projectType: "nonfiction",
            chapterTitle: "The Cost of Staying Stuck",
            chapterSummary: "Show why reactive work remains expensive.",
            voiceProfile: { cadence: "short and direct" },
          },
        }),
      ),
      4_000,
    );
    await seedBudgetUsage(fixture.userId, 1_000 - reservation);

    const responses = await Promise.all([
      requestEditorAi(fixture.cookie, request),
      requestEditorAi(fixture.cookie, request),
    ]);

    expect(responses.map((response) => response.status).sort()).toEqual([200, 402]);
    expect(gatewayCalls).toBe(1);
    expect(await budgetUsageCents(fixture.userId)).toBe(1_000 - reservation + 1);
  });

  it("settles a conservative reservation down to actual hosted usage", async () => {
    const fixture = await createFixture("free");
    const requestId = crypto.randomUUID();
    const response = await requestEditorAi(
      fixture.cookie,
      payload("chapter", fixture.resourceIds.chapter),
      { "Idempotency-Key": requestId },
    );
    expect(response.status).toBe(200);

    const request = await budgetRequest(requestId);
    expect(request).toMatchObject({ status: "succeeded", actual_cents: 1 });
    expect(request?.reserved_cents).toBeGreaterThan(1);
    expect(await budgetUsageCents(fixture.userId)).toBe(1);
  });

  it("enforces the D1 daily cap on editor and retained chapter requests", async () => {
    const fixture = await createFixture("free");
    await seedBudgetUsage(fixture.userId, 1_000);

    const editor = await requestEditorAi(
      fixture.cookie,
      payload("chapter", fixture.resourceIds.chapter),
    );
    expect(editor.status).toBe(402);

    const inline = await requestInlineRevision(fixture);
    expect(inline.status).toBe(402);
    expect(gatewayCalls).toBe(0);
  });

  it("replays a hosted chapter inline revision without invoking the provider twice", async () => {
    const fixture = await createFixture();
    const requestId = crypto.randomUUID();
    const first = await requestInlineRevision(fixture, undefined, {
      "Idempotency-Key": requestId,
    });
    expect(first.status).toBe(200);
    const firstBody = (await first.json()) as RevisionResponse;

    const replay = await requestInlineRevision(fixture, undefined, {
      "Idempotency-Key": requestId,
    });
    expect(replay.status).toBe(200);
    await expect(replay.json()).resolves.toEqual(firstBody);
    expect(gatewayCalls).toBe(1);
  });

  it("allows an exhausted user to use the zero-cost local chapter revision fallback", async () => {
    const fixture = await createFixture("free");
    await seedBudgetUsage(fixture.userId, 1_000);
    mutableEnv.AI_GATEWAY_BASE_URL = "";
    mutableEnv.AI_GATEWAY_TOKEN = "";

    const response = await requestInlineRevision(fixture, undefined, {
      "Idempotency-Key": "",
    });

    expect(response.status).toBe(200);
    const body = (await response.json()) as RevisionResponse;
    expect(body.revision.llm_response.route).toBe("deterministic/local");
    expect(await budgetUsageCents(fixture.userId)).toBe(1_000);
    expect(gatewayCalls).toBe(0);
  });

  it("returns the chapter draft version observed by a metadata update", async () => {
    const fixture = await createFixture();
    const chapterId = fixture.resourceIds.chapter;
    await env.DB.prepare(`
      CREATE TRIGGER bump_chapter_version_before_metadata_update
      BEFORE UPDATE OF title ON chapters
      BEGIN
        UPDATE chapters SET draft_version = draft_version + 1 WHERE id = OLD.id;
      END
    `).run();

    try {
      const response = await requestDraftPatch(fixture, "chapter", { title: "Updated chapter" });
      expect(response.status).toBe(200);
      await expect(response.json()).resolves.toMatchObject({ draft_version: 1 });
    } finally {
      await env.DB.prepare(
        "DROP TRIGGER IF EXISTS bump_chapter_version_before_metadata_update",
      ).run();
    }
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
