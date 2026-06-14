import { WorkflowEntrypoint } from "cloudflare:workers";
import type { WorkflowEvent, WorkflowStep } from "cloudflare:workers";
import { getContainer } from "@cloudflare/containers";
import type { Container } from "@cloudflare/containers";
import { and, asc, eq, isNull } from "drizzle-orm";
import { drizzle } from "drizzle-orm/d1";
import { chapters, projects, render_jobs } from "../db/schema";
import type { Env } from "../env";
import { type ExportKind, manuscriptMarkdown, normalizeExportKinds } from "./book-export-helpers";

export type BookExportWorkflowParams = {
  projectId: string;
  userId: string;
  formats?: ExportKind[];
};

type Manuscript = {
  title: string;
  manuscriptMd: string;
};

type RenderWorkerResponse = {
  kind: ExportKind;
  contentType: string;
  bodyBase64: string;
  bytes: number;
};

export class BookExportWorkflow extends WorkflowEntrypoint<Env, BookExportWorkflowParams> {
  async run(event: WorkflowEvent<BookExportWorkflowParams>, step: WorkflowStep) {
    const payload = event.payload;
    if (!payload?.projectId || !payload.userId)
      throw new Error("projectId and userId are required");

    const manuscript = await step.do("assemble manuscript", () =>
      assembleManuscript(this.env, payload.projectId, payload.userId),
    );
    const formats = normalizeExportKinds(payload.formats);
    const jobs = await step.do("queue render jobs", () =>
      createRenderJobs(this.env, payload.projectId, formats, event.instanceId),
    );

    const outputs: { kind: ExportKind; r2Key: string; bytes: number }[] = [];
    for (const kind of formats) {
      const jobId = jobs[kind];
      const output = await step.do(`render ${kind}`, async () => {
        await updateRenderJob(this.env, jobId, { status: "running" });
        try {
          const rendered = await renderWithContainer(this.env, payload.projectId, kind, manuscript);
          const r2Key = `exports/${payload.projectId}/${kind}.${kind}`;
          await this.env.R2.put(r2Key, decodeBase64(rendered.bodyBase64), {
            httpMetadata: { contentType: rendered.contentType },
          });
          await updateRenderJob(this.env, jobId, {
            status: "completed",
            output_r2_key: r2Key,
            completed_at: new Date(),
          });
          return { kind, r2Key, bytes: rendered.bytes };
        } catch (error) {
          await updateRenderJob(this.env, jobId, {
            status: "failed",
            error: error instanceof Error ? error.message : String(error),
            completed_at: new Date(),
          });
          throw error;
        }
      });
      outputs.push(output);
    }

    return { projectId: payload.projectId, outputs };
  }
}

export async function assembleManuscript(env: Env, projectId: string, userId: string) {
  const db = drizzle(env.DB);
  const [project] = await db
    .select({ id: projects.id, title: projects.title })
    .from(projects)
    .where(
      and(eq(projects.id, projectId), eq(projects.user_id, userId), isNull(projects.deleted_at)),
    )
    .limit(1);
  if (!project) throw new Error("project not found");

  const rows = await db
    .select({
      ordinal: chapters.ordinal,
      title: chapters.title,
      summary: chapters.summary,
      draft_md: chapters.draft_md,
    })
    .from(chapters)
    .where(eq(chapters.project_id, projectId))
    .orderBy(asc(chapters.ordinal));
  if (rows.length === 0) throw new Error("generate chapters before exporting");

  return {
    title: project.title,
    manuscriptMd: manuscriptMarkdown(project.title, rows),
  };
}

async function createRenderJobs(
  env: Env,
  projectId: string,
  formats: ExportKind[],
  workflowId?: string,
) {
  const db = drizzle(env.DB);
  const ids = Object.fromEntries(formats.map((kind) => [kind, crypto.randomUUID()])) as Record<
    ExportKind,
    string
  >;
  await db.insert(render_jobs).values(
    formats.map((kind) => ({
      id: ids[kind],
      project_id: projectId,
      kind,
      status: "queued" as const,
      workflow_id: workflowId,
    })),
  );
  return ids;
}

async function updateRenderJob(
  env: Env,
  id: string,
  values: Partial<typeof render_jobs.$inferInsert>,
) {
  await drizzle(env.DB).update(render_jobs).set(values).where(eq(render_jobs.id, id));
}

async function renderWithContainer(
  env: Env,
  projectId: string,
  kind: ExportKind,
  manuscript: Manuscript,
) {
  if (!env.RENDER_WORKER) throw new Error("render worker binding is not configured");
  const binding = env.RENDER_WORKER as unknown as DurableObjectNamespace<Container>;
  const container = getContainer(binding, `render-export-${projectId}-${kind}`);
  const res = await container.fetch("http://render/render", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "X-Internal-Token": env.RENDER_WORKER_INTERNAL_TOKEN ?? "",
    },
    body: JSON.stringify({
      projectId,
      kind,
      title: manuscript.title,
      manuscriptMd: manuscript.manuscriptMd,
      inline: true,
    }),
  });
  if (!res.ok) throw new Error(`render worker ${kind} failed with ${res.status}`);
  const body = (await res.json()) as RenderWorkerResponse;
  if (!body.bodyBase64) throw new Error(`render worker ${kind} did not return bytes`);
  return body;
}

function decodeBase64(value: string) {
  const binary = atob(value);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i += 1) bytes[i] = binary.charCodeAt(i);
  return bytes;
}
