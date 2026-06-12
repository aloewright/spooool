import { WorkflowEntrypoint } from "cloudflare:workers";
import type { WorkflowEvent, WorkflowStep } from "cloudflare:workers";
import { getContainer } from "@cloudflare/containers";
import type { Container } from "@cloudflare/containers";
import { and, desc, eq, isNull } from "drizzle-orm";
import { drizzle } from "drizzle-orm/d1";
import {
  gtm_briefs,
  market_findings,
  market_queries,
  projects,
  publisher_packs,
} from "../db/schema";
import type { Env } from "../env";
import {
  type GtmBriefContent,
  type GtmBriefInput,
  renderGtmBriefMarkdown,
  synthesizeGtmBrief,
} from "../skills/launch/gtm";

export type GtmBriefWorkflowParams = {
  projectId: string;
  userId: string;
};

type LaunchPackageResponse = {
  contentType: string;
  bodyBase64: string;
  bytes: number;
};

export class GtmBriefWorkflow extends WorkflowEntrypoint<Env, GtmBriefWorkflowParams> {
  async run(event: WorkflowEvent<GtmBriefWorkflowParams>, step: WorkflowStep) {
    const payload = event.payload;
    if (!payload?.projectId || !payload.userId)
      throw new Error("projectId and userId are required");

    const input = await step.do("prepare launch input", () =>
      prepareGtmBriefInput(this.env, payload.projectId, payload.userId),
    );
    const brief = await step.do("synthesize launch brief", () =>
      synthesizeGtmBrief(this.env, input),
    );
    const saved = await step.do("package launch handoff", async () => {
      const briefId = crypto.randomUUID();
      const r2Key = `launch/${payload.projectId}/${briefId}.zip`;
      const rendered = await packageLaunchBrief(this.env, payload.projectId, {
        content: brief.content_json,
        briefMd: brief.brief_md,
      });
      await this.env.R2.put(r2Key, decodeBase64(rendered.bodyBase64), {
        httpMetadata: { contentType: rendered.contentType },
        customMetadata: { brief_id: briefId },
      });
      await drizzle(this.env.DB).insert(gtm_briefs).values({
        id: briefId,
        project_id: payload.projectId,
        content_json: brief.content_json,
        brief_md: brief.brief_md,
        r2_key: r2Key,
        created_at: new Date(),
        updated_at: new Date(),
      });
      return { id: briefId, r2Key, bytes: rendered.bytes };
    });

    return { projectId: payload.projectId, briefId: saved.id, r2Key: saved.r2Key };
  }
}

export async function prepareGtmBriefInput(
  env: Pick<Env, "DB">,
  projectId: string,
  userId: string,
): Promise<GtmBriefInput> {
  const db = drizzle(env.DB);
  const [project] = await db
    .select({
      id: projects.id,
      title: projects.title,
      type: projects.type,
      genre: projects.genre,
    })
    .from(projects)
    .where(
      and(eq(projects.id, projectId), eq(projects.user_id, userId), isNull(projects.deleted_at)),
    )
    .limit(1);
  if (!project) throw new Error("project not found");

  const [pack] = await db
    .select()
    .from(publisher_packs)
    .where(and(eq(publisher_packs.project_id, projectId), eq(publisher_packs.status, "approved")))
    .orderBy(desc(publisher_packs.updated_at))
    .limit(1);
  if (!pack) throw new Error("approve the publisher pack before creating a launch handoff");

  const findingRows = await db
    .select({
      summary_md: market_findings.summary_md,
      evidence_json: market_findings.evidence_json,
    })
    .from(market_findings)
    .innerJoin(market_queries, eq(market_queries.id, market_findings.query_id))
    .where(and(eq(market_queries.project_id, projectId), eq(market_queries.user_id, userId)))
    .orderBy(desc(market_findings.created_at))
    .limit(3);

  return {
    project: { title: project.title, type: project.type, genre: project.genre },
    publisherPack: {
      title: pack.title,
      subtitle: pack.subtitle,
      series_name: pack.series_name,
      description_html: pack.description_html,
      keywords: Array.isArray(pack.keywords_json) ? pack.keywords_json.map(String) : [],
      bisac: Array.isArray(pack.bisac_json) ? pack.bisac_json.map(String) : [],
    },
    marketFindings: findingRows.map((row) => ({
      summary_md: row.summary_md,
      evidence_json: row.evidence_json as GtmBriefInput["marketFindings"][number]["evidence_json"],
    })),
  };
}

export function latestGtmBrief(env: Pick<Env, "DB">, projectId: string) {
  return drizzle(env.DB)
    .select()
    .from(gtm_briefs)
    .where(eq(gtm_briefs.project_id, projectId))
    .orderBy(desc(gtm_briefs.updated_at))
    .limit(1);
}

export async function packageLaunchBrief(
  env: Pick<Env, "RENDER_WORKER" | "RENDER_WORKER_INTERNAL_TOKEN">,
  projectId: string,
  input: { content: GtmBriefContent; briefMd?: string },
) {
  if (!env.RENDER_WORKER) throw new Error("render worker binding is not configured");
  const binding = env.RENDER_WORKER as unknown as DurableObjectNamespace<Container>;
  const container = getContainer(binding, `launch-handoff-${projectId}`);
  const res = await container.fetch("http://render/package-launch", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "X-Internal-Token": env.RENDER_WORKER_INTERNAL_TOKEN ?? "",
    },
    body: JSON.stringify({
      projectId,
      handoff: input.content,
      briefMd: input.briefMd ?? renderGtmBriefMarkdown(input.content),
      inline: true,
    }),
  });
  if (!res.ok) throw new Error(`render worker launch package failed with ${res.status}`);
  const body = (await res.json()) as LaunchPackageResponse;
  if (!body.bodyBase64) throw new Error("render worker did not return launch package bytes");
  return body;
}

function decodeBase64(value: string) {
  const binary = atob(value);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i += 1) bytes[i] = binary.charCodeAt(i);
  return bytes;
}
