import { SELF } from "cloudflare:test";
import { describe, expect, it } from "vitest";

async function signUp() {
  const res = await SELF.fetch("http://x/api/auth/sign-up/email", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      email: `publisher-${crypto.randomUUID()}@x.test`,
      password: "correct-horse-battery-staple",
      name: "T",
    }),
  });
  return res.headers.get("set-cookie") ?? "";
}

describe("publisher pack", () => {
  it("generates, edits, and approves SEO metadata", async () => {
    const cookie = await signUp();
    const headers = { "Content-Type": "application/json", cookie };

    const projectRes = await SELF.fetch("http://x/api/v1/projects", {
      method: "POST",
      headers,
      body: JSON.stringify({ title: "Quiet Operator", type: "nonfiction" }),
    });
    // biome-ignore lint/suspicious/noExplicitAny: response shape from our own API
    const project = (await projectRes.json()) as any;

    const emptyGenerate = await SELF.fetch(
      `http://x/api/v1/projects/${project.id}/publisher-pack/seo`,
      { method: "POST", headers },
    );
    expect(emptyGenerate.status).toBe(409);

    await SELF.fetch(`http://x/api/v1/projects/${project.id}/outlines`, {
      method: "POST",
      headers,
      body: JSON.stringify({
        framework: "paas",
        questionnaire: "Readers need a calmer operating model for focused work.",
      }),
    });

    const generate = await SELF.fetch(`http://x/api/v1/projects/${project.id}/publisher-pack/seo`, {
      method: "POST",
      headers,
    });
    expect(generate.status).toBe(201);
    // biome-ignore lint/suspicious/noExplicitAny: response shape from our own API
    const generated = (await generate.json()) as any;
    expect(generated.pack.status).toBe("draft");
    expect(generated.pack.keywords).toHaveLength(7);
    expect(generated.pack.bisac).toHaveLength(2);

    const edited = { ...generated.pack, subtitle: "A calmer system for focused work" };
    const patch = await SELF.fetch(`http://x/api/v1/projects/${project.id}/publisher-pack`, {
      method: "PATCH",
      headers,
      body: JSON.stringify({
        title: edited.title,
        subtitle: edited.subtitle,
        series_name: edited.series_name,
        description_html: edited.description_html,
        keywords: edited.keywords,
        bisac: edited.bisac,
      }),
    });
    expect(patch.status).toBe(200);

    const approve = await SELF.fetch(
      `http://x/api/v1/projects/${project.id}/publisher-pack/approve`,
      { method: "POST", headers },
    );
    expect(approve.status).toBe(200);
    // biome-ignore lint/suspicious/noExplicitAny: response shape from our own API
    const approved = (await approve.json()) as any;
    expect(approved.pack.status).toBe("approved");

    const lockedPatch = await SELF.fetch(`http://x/api/v1/projects/${project.id}/publisher-pack`, {
      method: "PATCH",
      headers,
      body: JSON.stringify({
        ...edited,
        subtitle: "Should not save",
      }),
    });
    expect(lockedPatch.status).toBe(409);
  });
});
