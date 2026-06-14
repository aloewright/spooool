import { SELF, env } from "cloudflare:test";
import { describe, expect, it } from "vitest";

async function signUp() {
  const res = await SELF.fetch("http://x/api/auth/sign-up/email", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      email: `voice-${crypto.randomUUID()}@x.test`,
      password: "correct-horse-battery-staple",
      name: "T",
    }),
  });
  return res.headers.get("set-cookie") ?? "";
}

describe("voices", () => {
  it("creates, lists, fetches, and assigns a voice", async () => {
    const cookie = await signUp();
    const headers = { "Content-Type": "application/json", cookie };

    const projectRes = await SELF.fetch("http://x/api/v1/projects", {
      method: "POST",
      headers,
      body: JSON.stringify({ title: "Voice Book", type: "nonfiction" }),
    });
    expect(projectRes.status).toBe(201);
    // biome-ignore lint/suspicious/noExplicitAny: response shape from our own API
    const project = (await projectRes.json()) as any;

    const voiceRes = await SELF.fetch("http://x/api/v1/voices", {
      method: "POST",
      headers,
      body: JSON.stringify({
        name: "Dry wit",
        samples: [{ source: "paste", text: "Short sentences. Precise claims. No mush." }],
      }),
    });
    expect(voiceRes.status).toBe(201);
    // biome-ignore lint/suspicious/noExplicitAny: response shape from our own API
    const voice = (await voiceRes.json()) as any;

    const listRes = await SELF.fetch("http://x/api/v1/voices", { headers });
    expect(listRes.status).toBe(200);
    // biome-ignore lint/suspicious/noExplicitAny: response shape from our own API
    const list = (await listRes.json()) as any;
    expect(list.items.some((item: { id: string }) => item.id === voice.id)).toBe(true);

    const detailRes = await SELF.fetch(`http://x/api/v1/voices/${voice.id}`, { headers });
    expect(detailRes.status).toBe(200);
    // biome-ignore lint/suspicious/noExplicitAny: response shape from our own API
    const detail = (await detailRes.json()) as any;
    expect(detail.samples).toHaveLength(1);
    expect(detail.profile_md).toContain("Voice profile");

    const stored = await env.R2.get(detail.samples[0].r2_key);
    expect(await stored?.text()).toContain("Precise claims");

    const assignRes = await SELF.fetch(`http://x/api/v1/projects/${project.id}`, {
      method: "PATCH",
      headers,
      body: JSON.stringify({ voice_id: voice.id }),
    });
    expect(assignRes.status).toBe(200);

    const getProjectRes = await SELF.fetch(`http://x/api/v1/projects/${project.id}`, { headers });
    // biome-ignore lint/suspicious/noExplicitAny: response shape from our own API
    const gotProject = (await getProjectRes.json()) as any;
    expect(gotProject.voice_id).toBe(voice.id);
    expect(gotProject.status).toBe("voice");
  });
});
