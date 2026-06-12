import { SELF, env } from "cloudflare:test";
import { describe, expect, it } from "vitest";

async function signUp() {
  const res = await SELF.fetch("http://x/api/auth/sign-up/email", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      email: `launch-${crypto.randomUUID()}@x.test`,
      password: "correct-horse-battery-staple",
      name: "Launch Tester",
    }),
  });
  return res.headers.get("set-cookie") ?? "";
}

describe("launch handoff", () => {
  it("requires an approved publisher pack and returns the latest brief", async () => {
    const cookie = await signUp();
    const headers = { "Content-Type": "application/json", cookie };

    const projectRes = await SELF.fetch("http://x/api/v1/projects", {
      method: "POST",
      headers,
      body: JSON.stringify({ title: "Quiet Operator", type: "nonfiction" }),
    });
    // biome-ignore lint/suspicious/noExplicitAny: response shape from our own API
    const project = (await projectRes.json()) as any;

    const blocked = await SELF.fetch(`http://x/api/v1/projects/${project.id}/launch/brief`, {
      method: "POST",
      headers,
    });
    expect(blocked.status).toBe(409);

    await env.R2.put(`launch/${project.id}/brief.zip`, new Uint8Array([80, 75, 3, 4]), {
      httpMetadata: { contentType: "application/zip" },
    });
    await env.DB.prepare(
      "insert into gtm_briefs (id, project_id, content_json, brief_md, r2_key, created_at, updated_at) values (?, ?, ?, ?, ?, unixepoch(), unixepoch())",
    )
      .bind(
        crypto.randomUUID(),
        project.id,
        JSON.stringify({
          title: "Quiet Operator",
          subtitle: "A calmer system for focused work",
          positioning: "Positioning",
          comp_titles: ["Comp A"],
          launch_checklist: ["Ship"],
          preorder_copy: { headline: "Pre-order", body: "Body" },
          email_sequence: [{ subject: "Subject", body: "Body" }],
          ad_headlines: ["Headline"],
          arc_reader_brief: "ARC brief",
          milestones: { week_1: ["W1"], month_1: ["M1"], month_3: ["M3"] },
        }),
        "# Quiet Operator Launch Handoff",
        `launch/${project.id}/brief.zip`,
      )
      .run();

    const latest = await SELF.fetch(`http://x/api/v1/projects/${project.id}/launch/brief`, {
      headers,
    });
    expect(latest.status).toBe(200);
    // biome-ignore lint/suspicious/noExplicitAny: response shape from our own API
    const latestBody = (await latest.json()) as any;
    expect(latestBody.brief.brief_md).toContain("Launch Handoff");
    expect(latestBody.brief.download_url).toContain("/launch/brief/download");

    const download = await SELF.fetch(
      `http://x/api/v1/projects/${project.id}/launch/brief/download`,
      { headers },
    );
    expect(download.status).toBe(200);
    expect(download.headers.get("content-type")).toContain("application/zip");
  });
});
