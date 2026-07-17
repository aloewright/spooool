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

describe("projects", () => {
  it("create + list + get + soft-delete", async () => {
    const cookie = await signUp();
    const headers = { "Content-Type": "application/json", cookie };

    const created = await SELF.fetch("http://x/api/v1/projects", {
      method: "POST",
      headers,
      body: JSON.stringify({
        title: "My Book",
        type: "nonfiction",
        genre: "Self-Help, Business",
        logline: "A calm operating model for focused work.",
        audience: ["Business readers"],
        voice_styles: ["Conversational", "Witty & sharp"],
      }),
    });
    expect(created.status).toBe(201);
    // biome-ignore lint/suspicious/noExplicitAny: response shape from our own API
    const { id } = (await created.json()) as any;

    const list = await SELF.fetch("http://x/api/v1/projects", { headers });
    // biome-ignore lint/suspicious/noExplicitAny: response shape from our own API
    const items = (await list.json()) as any;
    expect(
      // biome-ignore lint/suspicious/noExplicitAny: row shape from our own API
      items.items.find((p: any) => p.id === id),
    ).toBeTruthy();

    const got = await SELF.fetch(`http://x/api/v1/projects/${id}`, { headers });
    expect(got.status).toBe(200);
    // biome-ignore lint/suspicious/noExplicitAny: response shape from our own API
    const gotBody = (await got.json()) as any;
    expect(gotBody.genre).toBe("Self-Help, Business");
    expect(gotBody.logline).toBe("A calm operating model for focused work.");
    expect(gotBody.audience_json).toEqual(["Business readers"]);
    expect(gotBody.voice_styles_json).toEqual(["Conversational", "Witty & sharp"]);

    const outline = await SELF.fetch(`http://x/api/v1/projects/${id}/outlines`, {
      method: "POST",
      headers,
      body: JSON.stringify({
        framework: "paas",
        questionnaire: "Reader needs a clear operating model for focused work.",
      }),
    });
    expect(outline.status).toBe(201);

    const regeneratedOutline = await SELF.fetch(`http://x/api/v1/projects/${id}/outlines`, {
      method: "POST",
      headers,
      body: JSON.stringify({
        framework: "reader-transformation",
        questionnaire:
          "Reader needs a clear operating model for focused work. The book should move them from reactive work to calm weekly planning.",
      }),
    });
    expect(regeneratedOutline.status).toBe(201);

    const outlineRes = await SELF.fetch(`http://x/api/v1/projects/${id}/outline`, { headers });
    // biome-ignore lint/suspicious/noExplicitAny: response shape from our own API
    const outlineBody = (await outlineRes.json()) as any;
    expect(outlineBody.chapters).toHaveLength(12);
    expect(outlineBody.chapters[0].summary).toContain("What might happen:");
    expect(outlineBody.chapters[0].summary).not.toContain(
      "Use the book premise as source material",
    );
    const chapterId = outlineBody.chapters[0].id;
    const patchChapter = await SELF.fetch(`http://x/api/v1/chapters/${chapterId}`, {
      method: "PATCH",
      headers,
      body: JSON.stringify({
        draft_md: "Finished chapter draft.",
        draft_version: 0,
        draft_session_id: crypto.randomUUID(),
        draft_sequence: 1,
        status: "drafted",
      }),
    });
    expect(patchChapter.status).toBe(200);

    const book = await SELF.fetch(`http://x/api/v1/projects/${id}/book`, { headers });
    expect(book.status).toBe(200);
    // biome-ignore lint/suspicious/noExplicitAny: response shape from our own API
    const bookBody = (await book.json()) as any;
    expect(bookBody.book.title).toBe("My Book");
    expect(bookBody.book.chapters[0].id).toBe(chapterId);
    expect(bookBody.book.chapters[0].body_md).toBe("Finished chapter draft.");
    expect(bookBody.export_formats).toEqual(["epub", "pdf"]);

    const del = await SELF.fetch(`http://x/api/v1/projects/${id}`, {
      method: "DELETE",
      headers,
    });
    expect(del.status).toBe(204);

    const list2 = await SELF.fetch("http://x/api/v1/projects", { headers });
    // biome-ignore lint/suspicious/noExplicitAny: response shape from our own API
    const items2 = (await list2.json()) as any;
    expect(
      // biome-ignore lint/suspicious/noExplicitAny: row shape from our own API
      items2.items.find((p: any) => p.id === id),
    ).toBeFalsy();

    const deleted = await SELF.fetch("http://x/api/v1/projects/deleted/recent", { headers });
    expect(deleted.status).toBe(200);
    // biome-ignore lint/suspicious/noExplicitAny: response shape from our own API
    const deletedBody = (await deleted.json()) as any;
    expect(deletedBody.retention_days).toBe(30);
    expect(
      // biome-ignore lint/suspicious/noExplicitAny: row shape from our own API
      deletedBody.items.find((p: any) => p.id === id),
    ).toBeTruthy();

    const restore = await SELF.fetch(`http://x/api/v1/projects/${id}/restore`, {
      method: "POST",
      headers,
    });
    expect(restore.status).toBe(200);

    const list3 = await SELF.fetch("http://x/api/v1/projects", { headers });
    // biome-ignore lint/suspicious/noExplicitAny: response shape from our own API
    const items3 = (await list3.json()) as any;
    expect(
      // biome-ignore lint/suspicious/noExplicitAny: row shape from our own API
      items3.items.find((p: any) => p.id === id),
    ).toBeTruthy();
  });
});
