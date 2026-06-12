import { SELF } from "cloudflare:test";
import { describe, expect, it } from "vitest";

async function signUp() {
  const res = await SELF.fetch("http://x/api/auth/sign-up/email", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      email: `narration-${crypto.randomUUID()}@x.test`,
      password: "correct-horse-battery-staple",
      name: "T",
    }),
  });
  return res.headers.get("set-cookie") ?? "";
}

describe("narration auditions", () => {
  it("stores ElevenLabs key state and requires it before auditioning", async () => {
    const cookie = await signUp();
    const headers = { "Content-Type": "application/json", cookie };

    const keyStatus = await SELF.fetch("http://x/api/v1/account/elevenlabs-key", { headers });
    expect(keyStatus.status).toBe(200);
    expect(await keyStatus.json()).toEqual({ configured: false });

    const projectRes = await SELF.fetch("http://x/api/v1/projects", {
      method: "POST",
      headers,
      body: JSON.stringify({ title: "Audio Ready", type: "nonfiction" }),
    });
    // biome-ignore lint/suspicious/noExplicitAny: response shape from our own API
    const project = (await projectRes.json()) as any;
    await SELF.fetch(`http://x/api/v1/projects/${project.id}/outlines`, {
      method: "POST",
      headers,
      body: JSON.stringify({
        framework: "paas",
        questionnaire: "Readers need a practical audiobook-ready manuscript.",
      }),
    });

    const missingKey = await SELF.fetch(
      `http://x/api/v1/projects/${project.id}/narration/audition`,
      {
        method: "POST",
        headers,
        body: JSON.stringify({ elevenlabs_voice_ids: ["JBFqnCBsd6RMkjVDRZzb"] }),
      },
    );
    expect(missingKey.status).toBe(409);

    const blockedMaster = await SELF.fetch(`http://x/api/v1/projects/${project.id}/audiobook`, {
      method: "POST",
      headers,
    });
    expect(blockedMaster.status).toBe(409);

    const saveKey = await SELF.fetch("http://x/api/v1/account/elevenlabs-key", {
      method: "PUT",
      headers,
      body: JSON.stringify({ api_key: "sk-test-narration-key" }),
    });
    expect(saveKey.status).toBe(200);

    const configured = await SELF.fetch("http://x/api/v1/account/elevenlabs-key", { headers });
    expect(await configured.json()).toEqual({ configured: true });
  });
});
