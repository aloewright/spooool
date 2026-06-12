import { WorkflowEntrypoint } from "cloudflare:workers";
import type { WorkflowEvent, WorkflowStep } from "cloudflare:workers";
import { getContainer } from "@cloudflare/containers";
import type { Container } from "@cloudflare/containers";
import { and, asc, eq, isNull } from "drizzle-orm";
import { drizzle } from "drizzle-orm/d1";
import { chapters, projects, render_jobs, users } from "../db/schema";
import type { Env } from "../env";
import { decryptSecret } from "../lib/keyring";
import { buildNarrationScript } from "../skills/publisher/narration";

export type AudiobookMasteringWorkflowParams = {
  projectId: string;
  userId: string;
};

type ChapterAudio = {
  chapterId: string;
  title: string;
  clipsBase64: string[];
};

type MasterAudioResponse = {
  contentType: string;
  bodyBase64: string;
  bytes: number;
};

type Approval = {
  voice_id: string;
};

export class AudiobookMasteringWorkflow extends WorkflowEntrypoint<
  Env,
  AudiobookMasteringWorkflowParams
> {
  async run(event: WorkflowEvent<AudiobookMasteringWorkflowParams>, step: WorkflowStep) {
    const payload = event.payload;
    if (!payload?.projectId || !payload.userId)
      throw new Error("projectId and userId are required");

    const input = await step.do("prepare audiobook input", () =>
      prepareAudiobookInput(this.env, payload.projectId, payload.userId),
    );
    const jobs = await step.do("queue audiobook jobs", () =>
      createAudiobookJobs(this.env, payload.projectId, input.chapters.length, event.instanceId),
    );

    const chapterAudio: ChapterAudio[] = [];
    for (const [index, chapter] of input.chapters.entries()) {
      const jobId = jobs.chapterJobs[index];
      const audio = await step.do(`render narration chapter ${index + 1}`, async () => {
        await updateRenderJob(this.env, jobId, { status: "running" });
        try {
          const clipsBase64 = [];
          for (const chunk of chapter.chunks) {
            const clip = await renderElevenLabsAudio(input.apiKey, input.voiceId, chunk.text);
            clipsBase64.push(arrayBufferToBase64(clip));
          }
          await updateRenderJob(this.env, jobId, { status: "completed", completed_at: new Date() });
          return { chapterId: chapter.chapterId, title: chapter.title, clipsBase64 };
        } catch (error) {
          await updateRenderJob(this.env, jobId, {
            status: "failed",
            error: error instanceof Error ? error.message : String(error),
            completed_at: new Date(),
          });
          throw error;
        }
      });
      chapterAudio.push(audio);
    }

    const master = await step.do("master audiobook", async () => {
      await updateRenderJob(this.env, jobs.masterJob, { status: "running" });
      try {
        const rendered = await masterWithContainer(this.env, payload.projectId, chapterAudio);
        const r2Key = `audiobooks/${payload.projectId}/master.zip`;
        await this.env.R2.put(r2Key, decodeBase64(rendered.bodyBase64), {
          httpMetadata: { contentType: rendered.contentType },
        });
        await updateRenderJob(this.env, jobs.masterJob, {
          status: "completed",
          output_r2_key: r2Key,
          completed_at: new Date(),
        });
        return { r2Key, bytes: rendered.bytes };
      } catch (error) {
        await updateRenderJob(this.env, jobs.masterJob, {
          status: "failed",
          error: error instanceof Error ? error.message : String(error),
          completed_at: new Date(),
        });
        throw error;
      }
    });

    return { projectId: payload.projectId, master };
  }
}

export async function prepareAudiobookInput(env: Env, projectId: string, userId: string) {
  const db = drizzle(env.DB);
  const [project] = await db
    .select({ id: projects.id })
    .from(projects)
    .where(
      and(eq(projects.id, projectId), eq(projects.user_id, userId), isNull(projects.deleted_at)),
    )
    .limit(1);
  if (!project) throw new Error("project not found");

  const approval = await env.KV.get<Approval>(`narration:approved:${projectId}`, "json");
  if (!approval?.voice_id) throw new Error("approve a narration audition before mastering");

  const [keyRow] = await db
    .select({
      ciphertext: users.elevenlabs_key_ciphertext,
      iv: users.elevenlabs_key_iv,
    })
    .from(users)
    .where(eq(users.id, userId))
    .limit(1);
  if (!keyRow?.ciphertext || !keyRow.iv) throw new Error("ElevenLabs API key is not configured");

  const rows = await db
    .select({
      chapterId: chapters.id,
      title: chapters.title,
      summary: chapters.summary,
      draft_md: chapters.draft_md,
    })
    .from(chapters)
    .where(eq(chapters.project_id, projectId))
    .orderBy(asc(chapters.ordinal));
  if (!rows.length) throw new Error("generate chapters before mastering audio");

  return {
    voiceId: approval.voice_id,
    apiKey: await decryptSecret(
      keyRow.ciphertext as ArrayBuffer | Uint8Array,
      keyRow.iv as ArrayBuffer | Uint8Array,
      env.KEYRING_MASTER_KEY,
    ),
    chapters: rows.map((row) => ({
      chapterId: row.chapterId,
      title: row.title,
      chunks: buildNarrationScript([row]).chunks,
    })),
  };
}

async function createAudiobookJobs(
  env: Env,
  projectId: string,
  chaptersCount: number,
  workflowId?: string,
) {
  const chapterJobs = Array.from({ length: chaptersCount }, () => crypto.randomUUID());
  const masterJob = crypto.randomUUID();
  await drizzle(env.DB)
    .insert(render_jobs)
    .values([
      ...chapterJobs.map((id, index) => ({
        id,
        project_id: projectId,
        kind: "narration" as const,
        status: "queued" as const,
        workflow_id: `${workflowId}:chapter:${index + 1}`,
      })),
      {
        id: masterJob,
        project_id: projectId,
        kind: "master_mix" as const,
        status: "queued" as const,
        workflow_id: workflowId,
      },
    ]);
  return { chapterJobs, masterJob };
}

async function updateRenderJob(
  env: Env,
  id: string,
  values: Partial<typeof render_jobs.$inferInsert>,
) {
  await drizzle(env.DB).update(render_jobs).set(values).where(eq(render_jobs.id, id));
}

async function masterWithContainer(env: Env, projectId: string, chapters: ChapterAudio[]) {
  if (!env.RENDER_WORKER) throw new Error("render worker binding is not configured");
  const binding = env.RENDER_WORKER as unknown as DurableObjectNamespace<Container>;
  const container = getContainer(binding, `audiobook-master-${projectId}`);
  const res = await container.fetch("http://render/master-audio", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "X-Internal-Token": env.RENDER_WORKER_INTERNAL_TOKEN ?? "",
    },
    body: JSON.stringify({ projectId, chapters, inline: true }),
  });
  if (!res.ok) throw new Error(`render worker audio mastering failed with ${res.status}`);
  const body = (await res.json()) as MasterAudioResponse;
  if (!body.bodyBase64) throw new Error("render worker did not return mastered audio bytes");
  return body;
}

async function renderElevenLabsAudio(apiKey: string, voiceId: string, text: string) {
  const res = await fetch(
    `https://api.elevenlabs.io/v1/text-to-speech/${encodeURIComponent(
      voiceId,
    )}?output_format=mp3_44100_128`,
    {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "xi-api-key": apiKey,
      },
      body: JSON.stringify({
        text,
        model_id: "eleven_multilingual_v2",
        voice_settings: { stability: 0.5, similarity_boost: 0.75 },
      }),
    },
  );
  if (!res.ok) {
    const message = await res.text().catch(() => res.statusText);
    throw new Error(`ElevenLabs ${res.status}: ${message.slice(0, 240)}`);
  }
  return await res.arrayBuffer();
}

function decodeBase64(value: string) {
  const binary = atob(value);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i += 1) bytes[i] = binary.charCodeAt(i);
  return bytes;
}

function arrayBufferToBase64(value: ArrayBuffer) {
  let binary = "";
  const bytes = new Uint8Array(value);
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary);
}
