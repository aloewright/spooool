import { SELF } from "cloudflare:test";
import { describe, expect, it } from "vitest";

async function signUp() {
  const res = await SELF.fetch("http://x/api/auth/sign-up/email", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      email: `u-${crypto.randomUUID()}@x.test`,
      password: "correct-horse-battery-staple",
      name: "Scout Tester",
    }),
  });
  return res.headers.get("set-cookie") ?? "";
}

describe("scout", () => {
  it("creates a market query, persists findings, and lists project findings", async () => {
    const cookie = await signUp();
    const headers = { "Content-Type": "application/json", cookie };

    const projectRes = await SELF.fetch("http://x/api/v1/projects", {
      method: "POST",
      headers,
      body: JSON.stringify({ title: "Cozy Systems", type: "nonfiction" }),
    });
    expect(projectRes.status).toBe(201);
    // biome-ignore lint/suspicious/noExplicitAny: response shape from our own API
    const project = (await projectRes.json()) as any;

    const created = await SELF.fetch("http://x/api/v1/scout/queries", {
      method: "POST",
      headers,
      body: JSON.stringify({
        niche: "productivity systems for neurodivergent founders",
        type: "nonfiction",
        project_id: project.id,
        params: {
          source: "integration-test",
          audience: "neurodivergent solo founders",
          angle: "a weekly operating system that lowers context switching",
        },
      }),
    });
    expect(created.status).toBe(201);
    // biome-ignore lint/suspicious/noExplicitAny: response shape from our own API
    const body = (await created.json()) as any;
    expect(body.query.project_id).toBe(project.id);
    expect(body.finding.summary_md).toContain("Scout read");
    expect(body.finding.evidence_json.records.length).toBeGreaterThan(0);
    expect(body.finding.evidence_json.opportunity_score).toBeGreaterThan(0);
    expect(body.finding.evidence_json.confidence).toMatch(/low|medium|high/);
    expect(body.finding.evidence_json.source_mix.kdp).toBeGreaterThan(0);
    expect(body.finding.evidence_json.keyword_counts.length).toBeGreaterThan(0);
    expect(body.finding.evidence_json.positioning_brief).toContain("Position");
    expect(body.finding.evidence_json.input_context.audience).toBe("neurodivergent solo founders");
    expect(body.finding.evidence_json.verdict.label).toMatch(/Ready|Validate|Reframe/);
    expect(body.finding.evidence_json.concept_brief.promise).toContain("weekly operating system");
    expect(body.finding.evidence_json.gaps).toHaveLength(3);
    expect(body.finding.evidence_json.validation_steps).toHaveLength(3);
    expect(body.finding.evidence_json.next_questions).toHaveLength(3);

    const list = await SELF.fetch("http://x/api/v1/scout/queries", { headers });
    expect(list.status).toBe(200);
    // biome-ignore lint/suspicious/noExplicitAny: response shape from our own API
    const listBody = (await list.json()) as any;
    expect(listBody.items[0].query.id).toBe(body.query.id);

    const projectFindings = await SELF.fetch(
      `http://x/api/v1/scout/projects/${project.id}/findings`,
      { headers },
    );
    expect(projectFindings.status).toBe(200);
    // biome-ignore lint/suspicious/noExplicitAny: response shape from our own API
    const projectBody = (await projectFindings.json()) as any;
    expect(projectBody.items[0].finding.id).toBe(body.finding.id);
  });
});
