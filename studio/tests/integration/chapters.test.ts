import { SELF } from "cloudflare:test";
import { describe, expect, it } from "vitest";

async function signUp() {
  const res = await SELF.fetch("http://x/api/auth/sign-up/email", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      email: `chapter-${crypto.randomUUID()}@x.test`,
      password: "correct-horse-battery-staple",
      name: "T",
    }),
  });
  return res.headers.get("set-cookie") ?? "";
}

describe("chapters", () => {
  it("generates outline chapters and autosaves a chapter draft", async () => {
    const cookie = await signUp();
    const headers = { "Content-Type": "application/json", cookie };

    const projectRes = await SELF.fetch("http://x/api/v1/projects", {
      method: "POST",
      headers,
      body: JSON.stringify({ title: "Chapter Book", type: "nonfiction" }),
    });
    // biome-ignore lint/suspicious/noExplicitAny: response shape from our own API
    const project = (await projectRes.json()) as any;

    const outlineRes = await SELF.fetch(`http://x/api/v1/projects/${project.id}/outlines`, {
      method: "POST",
      headers,
      body: JSON.stringify({
        framework: "paas",
        questionnaire: "Readers need a calmer operating model for focused work.",
      }),
    });
    expect(outlineRes.status).toBe(201);

    const outlineDetail = await SELF.fetch(`http://x/api/v1/projects/${project.id}/outline`, {
      headers,
    });
    // biome-ignore lint/suspicious/noExplicitAny: response shape from our own API
    const outline = (await outlineDetail.json()) as any;
    expect(outline.chapters.length).toBeGreaterThan(0);

    const chapterId = outline.chapters[0].id;
    const sectionRes = await SELF.fetch(`http://x/api/v1/chapters/${chapterId}/sections`, {
      headers,
    });
    expect(sectionRes.status).toBe(200);
    // biome-ignore lint/suspicious/noExplicitAny: response shape from our own API
    const sections = (await sectionRes.json()) as any;
    expect(sections.items.length).toBeGreaterThan(0);

    const unversionedDraft = await SELF.fetch(`http://x/api/v1/chapters/${chapterId}`, {
      method: "PATCH",
      headers,
      body: JSON.stringify({ draft_md: "Missing its write order." }),
    });
    expect(unversionedDraft.status).toBe(400);

    const draftSection = await SELF.fetch(
      `http://x/api/v1/chapters/${chapterId}/sections/${sections.items[0].id}/draft`,
      { method: "POST", headers },
    );
    expect(draftSection.status).toBe(200);
    // biome-ignore lint/suspicious/noExplicitAny: response shape from our own API
    const sectionDraft = (await draftSection.json()) as any;
    expect(sectionDraft.section.draft_md).toContain("concrete moment");
    expect(sectionDraft.revision.after_md).toContain("concrete moment");

    const draftSessionId = crypto.randomUUID();
    const patch = await SELF.fetch(`http://x/api/v1/chapters/${chapterId}`, {
      method: "PATCH",
      headers,
      body: JSON.stringify({
        draft_json: [{ type: "paragraph", content: "A saved chapter draft." }],
        draft_md: "A saved chapter draft.",
        draft_version: 0,
        draft_session_id: draftSessionId,
        draft_sequence: 1,
        status: "drafting",
      }),
    });
    expect(patch.status).toBe(200);

    const get = await SELF.fetch(`http://x/api/v1/chapters/${chapterId}`, { headers });
    // biome-ignore lint/suspicious/noExplicitAny: response shape from our own API
    const chapter = (await get.json()) as any;
    expect(chapter.draft_md).toContain("saved chapter");
    expect(chapter.draft_version).toBe(1);
    expect(chapter.status).toBe("drafting");

    const newerDraft = await SELF.fetch(`http://x/api/v1/chapters/${chapterId}`, {
      method: "PATCH",
      headers,
      body: JSON.stringify({
        draft_md: "The newest chapter draft.",
        draft_version: 1,
        draft_session_id: draftSessionId,
        draft_sequence: 2,
      }),
    });
    expect(newerDraft.status).toBe(200);
    const staleDraft = await SELF.fetch(`http://x/api/v1/chapters/${chapterId}`, {
      method: "PATCH",
      headers,
      body: JSON.stringify({
        draft_md: "A delayed older draft.",
        draft_version: 1,
        draft_session_id: crypto.randomUUID(),
        draft_sequence: 99,
      }),
    });
    expect(staleDraft.status).toBe(409);
    const afterStale = await SELF.fetch(`http://x/api/v1/chapters/${chapterId}`, { headers });
    // biome-ignore lint/suspicious/noExplicitAny: response shape from our own API
    const afterStaleBody = (await afterStale.json()) as any;
    expect(afterStaleBody.draft_md).toBe("The newest chapter draft.");
    expect(afterStaleBody.draft_version).toBe(2);

    const additiveDraft = await SELF.fetch(
      `http://x/api/v1/chapters/${chapterId}/sections/${sections.items[1].id}/draft`,
      { method: "POST", headers },
    );
    expect(additiveDraft.status).toBe(200);
    // biome-ignore lint/suspicious/noExplicitAny: response shape from our own API
    const additiveSection = (await additiveDraft.json()) as any;
    expect(additiveSection.section.draft_md).toContain("Continue from the current chapter draft");
    expect(additiveSection.section.draft_md).toContain("without replaying its opening");

    const directedRedraft = await SELF.fetch(
      `http://x/api/v1/chapters/${chapterId}/sections/${sections.items[1].id}/draft`,
      {
        method: "POST",
        headers,
        body: JSON.stringify({ instruction: "Make the continuation more tense." }),
      },
    );
    expect(directedRedraft.status).toBe(200);
    // biome-ignore lint/suspicious/noExplicitAny: response shape from our own API
    const directedSection = (await directedRedraft.json()) as any;
    expect(directedSection.section.draft_md).toContain(
      "Apply this redraft direction: Make the continuation more tense.",
    );

    const revise = await SELF.fetch(`http://x/api/v1/chapters/${chapterId}/revise`, {
      method: "POST",
      headers,
      body: JSON.stringify({
        action: "tighten",
        text: "This selected sentence should become sharper.",
        context_md: "A saved chapter draft.",
      }),
    });
    expect(revise.status).toBe(200);
    // biome-ignore lint/suspicious/noExplicitAny: response shape from our own API
    const inline = (await revise.json()) as any;
    expect(inline.revision.before_md).toContain("selected sentence");
    expect(inline.revision.after_md).toContain("Tightened:");
  });
});
