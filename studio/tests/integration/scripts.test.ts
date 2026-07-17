import { SELF } from "cloudflare:test";
import { describe, expect, it } from "vitest";

async function signUp() {
  const res = await SELF.fetch("http://x/api/auth/sign-up/email", {
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

function scriptPayload(overrides: Record<string, unknown> = {}) {
  return {
    title: "Final Approach",
    format: "feature",
    logline:
      "A burned-out air-traffic controller must talk her estranged brother's plane through a storm.",
    genre: "Drama, Thriller",
    ...overrides,
  };
}

describe("scripts", () => {
  it("create + list + get + plan + scenes + soft-delete + restore", async () => {
    const cookie = await signUp();
    const headers = { "Content-Type": "application/json", cookie };

    const created = await SELF.fetch("http://x/api/v1/scripts", {
      method: "POST",
      headers,
      body: JSON.stringify(scriptPayload()),
    });
    expect(created.status).toBe(201);
    // biome-ignore lint/suspicious/noExplicitAny: response shape from our own API
    const { id } = (await created.json()) as any;

    const list = await SELF.fetch("http://x/api/v1/scripts", { headers });
    // biome-ignore lint/suspicious/noExplicitAny: response shape from our own API
    const items = (await list.json()) as any;
    // biome-ignore lint/suspicious/noExplicitAny: row shape from our own API
    expect(items.items.find((s: any) => s.id === id)).toBeTruthy();

    const got = await SELF.fetch(`http://x/api/v1/scripts/${id}`, { headers });
    expect(got.status).toBe(200);
    // biome-ignore lint/suspicious/noExplicitAny: response shape from our own API
    const script = (await got.json()) as any;
    expect(script.format).toBe("feature");
    expect(script.logline).toContain("air-traffic controller");
    expect(script.genre).toBe("Drama, Thriller");
    expect(script.status).toBe("concept");

    const badStructure = await SELF.fetch(`http://x/api/v1/scripts/${id}/plan`, {
      method: "POST",
      headers,
      body: JSON.stringify({ structure: "five-act", planned_scenes: 15 }),
    });
    expect(badStructure.status).toBe(400);

    const tooFew = await SELF.fetch(`http://x/api/v1/scripts/${id}/plan`, {
      method: "POST",
      headers,
      body: JSON.stringify({ structure: "save-the-cat", planned_scenes: 5 }),
    });
    expect(tooFew.status).toBe(400);
    // biome-ignore lint/suspicious/noExplicitAny: response shape from our own API
    const tooFewErr = (await tooFew.json()) as any;
    expect(tooFewErr.error).toContain("at least 8");

    const planned = await SELF.fetch(`http://x/api/v1/scripts/${id}/plan`, {
      method: "POST",
      headers,
      body: JSON.stringify({ structure: "save-the-cat", planned_scenes: 15 }),
    });
    expect(planned.status).toBe(200);
    // biome-ignore lint/suspicious/noExplicitAny: response shape from our own API
    const planBody = (await planned.json()) as any;
    expect(planBody.scenes_created).toBe(15);

    const scenes = await SELF.fetch(`http://x/api/v1/scripts/${id}/scenes`, { headers });
    expect(scenes.status).toBe(200);
    // biome-ignore lint/suspicious/noExplicitAny: response shape from our own API
    const scenesBody = (await scenes.json()) as any;
    expect(scenesBody.items).toHaveLength(15);
    expect(scenesBody.items[0].ordinal).toBe(1);
    expect(scenesBody.items[0].status).toBe("planned");
    // Structure beats pre-title the planned scenes.
    expect(scenesBody.items[0].title).toBe("Opening Image");
    expect(scenesBody.items[0].summary.length).toBeGreaterThan(0);

    // Replanning below the number of already-created scenes is rejected.
    const replanTooFew = await SELF.fetch(`http://x/api/v1/scripts/${id}/plan`, {
      method: "POST",
      headers,
      body: JSON.stringify({ structure: "save-the-cat", planned_scenes: 8 }),
    });
    expect(replanTooFew.status).toBe(400);

    const sceneId = scenesBody.items[0].id;
    const sceneDraftSessionId = crypto.randomUUID();
    const draftJson = [{ type: "paragraph", content: "INT. TOWER — NIGHT" }];
    const unversionedDraft = await SELF.fetch(`http://x/api/v1/scripts/${id}/scenes/${sceneId}`, {
      method: "PATCH",
      headers,
      body: JSON.stringify({ draft_md: "Missing its write order." }),
    });
    expect(unversionedDraft.status).toBe(400);
    const patchScene = await SELF.fetch(`http://x/api/v1/scripts/${id}/scenes/${sceneId}`, {
      method: "PATCH",
      headers,
      body: JSON.stringify({
        title: "Storm Watch",
        draft_json: draftJson,
        draft_md: "INT. TOWER — NIGHT",
        draft_version: 0,
        draft_session_id: sceneDraftSessionId,
        draft_sequence: 1,
        status: "drafted",
      }),
    });
    expect(patchScene.status).toBe(200);

    const gotScene = await SELF.fetch(`http://x/api/v1/scripts/${id}/scenes/${sceneId}`, {
      headers,
    });
    expect(gotScene.status).toBe(200);
    // biome-ignore lint/suspicious/noExplicitAny: response shape from our own API
    const sceneBody = (await gotScene.json()) as any;
    expect(sceneBody.title).toBe("Storm Watch");
    expect(sceneBody.draft_json).toEqual(draftJson);
    expect(sceneBody.draft_md).toBe("INT. TOWER — NIGHT");
    expect(sceneBody.draft_version).toBe(1);
    expect(sceneBody.status).toBe("drafted");

    const missingScene = await SELF.fetch(
      `http://x/api/v1/scripts/${id}/scenes/${crypto.randomUUID()}`,
      {
        headers,
      },
    );
    expect(missingScene.status).toBe(404);

    // Malformed draft_json (not a block array) is rejected, not stored.
    const badDraftJson = await SELF.fetch(`http://x/api/v1/scripts/${id}/scenes/${sceneId}`, {
      method: "PATCH",
      headers,
      body: JSON.stringify({ draft_json: { nested: "object" } }),
    });
    expect(badDraftJson.status).toBeGreaterThanOrEqual(400);

    // First draft content promotes a planned scene to drafting server-side…
    const secondSceneId = scenesBody.items[1].id;
    const secondSceneDraftSessionId = crypto.randomUUID();
    await SELF.fetch(`http://x/api/v1/scripts/${id}/scenes/${secondSceneId}`, {
      method: "PATCH",
      headers,
      body: JSON.stringify({
        draft_md: "Opening line.",
        draft_version: 0,
        draft_session_id: secondSceneDraftSessionId,
        draft_sequence: 1,
      }),
    });
    const promoted = await SELF.fetch(`http://x/api/v1/scripts/${id}/scenes/${secondSceneId}`, {
      headers,
    });
    // biome-ignore lint/suspicious/noExplicitAny: response shape from our own API
    expect(((await promoted.json()) as any).status).toBe("drafting");

    // …but a draft-only save never downgrades an explicitly drafted scene.
    await SELF.fetch(`http://x/api/v1/scripts/${id}/scenes/${secondSceneId}`, {
      method: "PATCH",
      headers,
      body: JSON.stringify({ status: "drafted" }),
    });
    await SELF.fetch(`http://x/api/v1/scripts/${id}/scenes/${secondSceneId}`, {
      method: "PATCH",
      headers,
      body: JSON.stringify({
        draft_md: "Opening line, revised.",
        draft_version: 1,
        draft_session_id: secondSceneDraftSessionId,
        draft_sequence: 2,
      }),
    });
    const stillDrafted = await SELF.fetch(`http://x/api/v1/scripts/${id}/scenes/${secondSceneId}`, {
      headers,
    });
    // biome-ignore lint/suspicious/noExplicitAny: response shape from our own API
    expect(((await stillDrafted.json()) as any).status).toBe("drafted");

    const staleDraft = await SELF.fetch(`http://x/api/v1/scripts/${id}/scenes/${secondSceneId}`, {
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
    const afterStale = await SELF.fetch(`http://x/api/v1/scripts/${id}/scenes/${secondSceneId}`, {
      headers,
    });
    // biome-ignore lint/suspicious/noExplicitAny: response shape from our own API
    const afterStaleBody = (await afterStale.json()) as any;
    expect(afterStaleBody.draft_md).toBe("Opening line, revised.");
    expect(afterStaleBody.draft_version).toBe(2);

    const del = await SELF.fetch(`http://x/api/v1/scripts/${id}`, { method: "DELETE", headers });
    expect(del.status).toBe(204);

    const list2 = await SELF.fetch("http://x/api/v1/scripts", { headers });
    // biome-ignore lint/suspicious/noExplicitAny: response shape from our own API
    const items2 = (await list2.json()) as any;
    // biome-ignore lint/suspicious/noExplicitAny: row shape from our own API
    expect(items2.items.find((s: any) => s.id === id)).toBeFalsy();

    const deleted = await SELF.fetch("http://x/api/v1/scripts/deleted/recent", { headers });
    // biome-ignore lint/suspicious/noExplicitAny: response shape from our own API
    const deletedBody = (await deleted.json()) as any;
    // biome-ignore lint/suspicious/noExplicitAny: row shape from our own API
    expect(deletedBody.items.find((s: any) => s.id === id)).toBeTruthy();

    const restore = await SELF.fetch(`http://x/api/v1/scripts/${id}/restore`, {
      method: "POST",
      headers,
    });
    expect(restore.status).toBe(200);

    const list3 = await SELF.fetch("http://x/api/v1/scripts", { headers });
    // biome-ignore lint/suspicious/noExplicitAny: response shape from our own API
    const items3 = (await list3.json()) as any;
    // biome-ignore lint/suspicious/noExplicitAny: row shape from our own API
    expect(items3.items.find((s: any) => s.id === id)).toBeTruthy();
  });

  it("preserves an explicit status racing first-draft promotion and returns current versions", async () => {
    const cookie = await signUp();
    const headers = { "Content-Type": "application/json", cookie };
    const created = await SELF.fetch("http://x/api/v1/scripts", {
      method: "POST",
      headers,
      body: JSON.stringify(scriptPayload({ title: "Concurrent Cut", format: "short-film" })),
    });
    expect(created.status).toBe(201);
    // biome-ignore lint/suspicious/noExplicitAny: response shape from our own API
    const { id } = (await created.json()) as any;

    const planned = await SELF.fetch(`http://x/api/v1/scripts/${id}/plan`, {
      method: "POST",
      headers,
      body: JSON.stringify({ structure: "mini-arc", planned_scenes: 3 }),
    });
    expect(planned.status).toBe(200);
    const scenes = await SELF.fetch(`http://x/api/v1/scripts/${id}/scenes`, { headers });
    // biome-ignore lint/suspicious/noExplicitAny: response shape from our own API
    const scenesBody = (await scenes.json()) as any;
    const sceneId = scenesBody.items[0].id;

    const [explicitStatus, firstDraft] = await Promise.all([
      SELF.fetch(`http://x/api/v1/scripts/${id}/scenes/${sceneId}`, {
        method: "PATCH",
        headers,
        body: JSON.stringify({ status: "drafted" }),
      }),
      SELF.fetch(`http://x/api/v1/scripts/${id}/scenes/${sceneId}`, {
        method: "PATCH",
        headers,
        body: JSON.stringify({
          draft_md: "INT. GARAGE — NIGHT",
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

    const afterRace = await SELF.fetch(`http://x/api/v1/scripts/${id}/scenes/${sceneId}`, {
      headers,
    });
    // biome-ignore lint/suspicious/noExplicitAny: response shape from our own API
    const afterRaceBody = (await afterRace.json()) as any;
    expect(afterRaceBody.status).toBe("drafted");
    expect(afterRaceBody.draft_version).toBe(1);

    const metadataPatch = await SELF.fetch(`http://x/api/v1/scripts/${id}/scenes/${sceneId}`, {
      method: "PATCH",
      headers,
      body: JSON.stringify({ title: "Concurrent Cut, Revised" }),
    });
    expect(metadataPatch.status).toBe(200);
    // biome-ignore lint/suspicious/noExplicitAny: response shape from our own API
    expect(((await metadataPatch.json()) as any).draft_version).toBe(1);
  });

  it("rejects a logline that is too short", async () => {
    const cookie = await signUp();
    const headers = { "Content-Type": "application/json", cookie };
    const res = await SELF.fetch("http://x/api/v1/scripts", {
      method: "POST",
      headers,
      body: JSON.stringify(scriptPayload({ logline: "Short." })),
    });
    expect(res.status).toBeGreaterThanOrEqual(400);
  });

  it("enforces the short film planning threshold", async () => {
    const cookie = await signUp();
    const headers = { "Content-Type": "application/json", cookie };
    const created = await SELF.fetch("http://x/api/v1/scripts", {
      method: "POST",
      headers,
      body: JSON.stringify(scriptPayload({ format: "short-film", title: "The Last Take" })),
    });
    expect(created.status).toBe(201);
    // biome-ignore lint/suspicious/noExplicitAny: response shape from our own API
    const { id } = (await created.json()) as any;

    const tooFew = await SELF.fetch(`http://x/api/v1/scripts/${id}/plan`, {
      method: "POST",
      headers,
      body: JSON.stringify({ structure: "mini-arc", planned_scenes: 2 }),
    });
    expect(tooFew.status).toBe(400);
    // biome-ignore lint/suspicious/noExplicitAny: response shape from our own API
    const err = (await tooFew.json()) as any;
    expect(err.error).toContain("at least 3");

    const enough = await SELF.fetch(`http://x/api/v1/scripts/${id}/plan`, {
      method: "POST",
      headers,
      body: JSON.stringify({ structure: "mini-arc", planned_scenes: 5 }),
    });
    expect(enough.status).toBe(200);

    const scenes = await SELF.fetch(`http://x/api/v1/scripts/${id}/scenes`, { headers });
    // biome-ignore lint/suspicious/noExplicitAny: response shape from our own API
    const scenesBody = (await scenes.json()) as any;
    expect(scenesBody.items).toHaveLength(5);
    expect(scenesBody.items[0].title).toBe("Hook");
    expect(scenesBody.items[4].title).toBe("Aftermath");
  });
});
