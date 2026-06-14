import { and, asc, eq } from "drizzle-orm";
import { drizzle } from "drizzle-orm/d1";
import { Hono } from "hono";
import { z } from "zod";
import { voice_samples, voices } from "../db/schema";
import type { Env } from "../env";
import { type AuthVariables, requireUser } from "../middleware/auth";
import { countWords, normalizePostPilotGuide, synthesizeVoiceProfile } from "../skills/voices";

const sampleSourceSchema = z.enum(["paste", "upload", "url"]);

const jsonSampleSchema = z.object({
  source: sampleSourceSchema,
  text: z.string().max(250_000).optional(),
  url: z.string().url().optional(),
  filename: z.string().max(160).optional(),
});

const createVoiceSchema = z.object({
  name: z.string().min(1).max(120),
  samples: z.array(jsonSampleSchema).max(5).optional(),
});

const importPostPilotSchema = z.object({
  slug: z
    .string()
    .trim()
    .min(1)
    .max(120)
    .regex(/^[a-z0-9][a-z0-9-_]*$/i),
});

const postPilotGuideIndexItemSchema = z.object({
  slug: z.string(),
  author: z.string(),
  era: z.string().optional(),
  kicker: z.string().optional(),
  standfirst: z.string().optional(),
  copyright_posture: z.string().optional(),
});

const postPilotGuideIndexSchema = z.object({
  items: z.array(postPilotGuideIndexItemSchema),
  nextOffset: z.number().nullable().optional(),
});

const addSampleSchema = jsonSampleSchema;

type SampleInput = z.infer<typeof jsonSampleSchema>;

export const voicesRoute = new Hono<{
  Bindings: Env;
  Variables: AuthVariables;
}>();

voicesRoute.use("*", requireUser);

voicesRoute.get("/", async (c) => {
  const user = c.get("user");
  const db = drizzle(c.env.DB);
  const items = await db
    .select()
    .from(voices)
    .where(eq(voices.user_id, user.id))
    .orderBy(asc(voices.name));
  return c.json({ items });
});

voicesRoute.get("/postpilot-guides", async (c) => {
  const guides = await loadPostPilotGuideIndex(c.env);
  return c.json({ items: guides });
});

voicesRoute.post("/", async (c) => {
  const user = c.get("user");
  const body = createVoiceSchema.parse(await c.req.json());
  const db = drizzle(c.env.DB);
  const id = crypto.randomUUID();

  await db.insert(voices).values({
    id,
    user_id: user.id,
    name: body.name,
    source: "custom",
  });

  for (const sample of body.samples ?? []) {
    await persistSample(c.env, db, id, sample);
  }
  await refreshProfile(c.env, db, id);

  return c.json({ id }, 201);
});

voicesRoute.post("/import-postpilot", async (c) => {
  const user = c.get("user");
  const body = importPostPilotSchema.parse(await c.req.json());
  const db = drizzle(c.env.DB);
  const guide = await loadPostPilotGuide(c.env, body.slug);
  const id = crypto.randomUUID();

  await db.insert(voices).values({
    id,
    user_id: user.id,
    name: guide.name,
    source: "postpilot",
    postpilot_slug: guide.slug,
    profile_md: guide.profile_md,
    profile_json: guide.profile_json,
  });

  for (const [index, exemplar] of guide.exemplars.slice(0, 5).entries()) {
    await persistSample(c.env, db, id, {
      source: "paste",
      text: exemplar,
      filename: `${guide.slug}-${index + 1}.txt`,
    });
  }

  return c.json({ id }, 201);
});

voicesRoute.get("/:id", async (c) => {
  const user = c.get("user");
  const id = c.req.param("id");
  const db = drizzle(c.env.DB);
  const [voice] = await db
    .select()
    .from(voices)
    .where(and(eq(voices.id, id), eq(voices.user_id, user.id)))
    .limit(1);
  if (!voice) return c.json({ error: "not found" }, 404);

  const samples = await db
    .select()
    .from(voice_samples)
    .where(eq(voice_samples.voice_id, id))
    .orderBy(asc(voice_samples.created_at));
  return c.json({ ...voice, samples });
});

voicesRoute.post("/:id/samples", async (c) => {
  const user = c.get("user");
  const id = c.req.param("id");
  const db = drizzle(c.env.DB);
  const [voice] = await db
    .select({ id: voices.id })
    .from(voices)
    .where(and(eq(voices.id, id), eq(voices.user_id, user.id)))
    .limit(1);
  if (!voice) return c.json({ error: "not found" }, 404);

  const sample = await parseSample(c.req.raw);
  await persistSample(c.env, db, id, sample);
  await refreshProfile(c.env, db, id);
  return c.json({ ok: true }, 201);
});

async function parseSample(req: Request): Promise<SampleInput> {
  const contentType = req.headers.get("content-type") ?? "";
  if (!contentType.includes("multipart/form-data")) {
    return addSampleSchema.parse(await req.json());
  }

  const form = await req.formData();
  const file = form.get("file");
  if (!(file instanceof File)) {
    throw new Error("multipart sample upload requires a file field");
  }
  const text = await file.text();
  return addSampleSchema.parse({
    source: "upload",
    text,
    filename: file.name,
  });
}

async function loadSampleText(input: SampleInput): Promise<string> {
  if (input.source === "url") {
    if (!input.url) throw new Error("url sample requires url");
    const res = await fetch(input.url, {
      headers: { "User-Agent": "BookGenerators/1.0 voice-sample-import" },
    });
    if (!res.ok) throw new Error(`sample url fetch failed: ${res.status}`);
    const contentType = res.headers.get("content-type") ?? "";
    if (!contentType.includes("text/") && !contentType.includes("html")) {
      throw new Error("sample url must return text or html");
    }
    const raw = (await res.text()).slice(0, 250_000);
    return raw.replace(/<script[\s\S]*?<\/script>/gi, "").replace(/<[^>]+>/g, " ");
  }

  if (!input.text?.trim()) throw new Error(`${input.source} sample requires text`);
  return input.text;
}

async function loadPostPilotGuide(env: Env, slug: string) {
  const cacheKey = `postpilot:${slug}:guide`;
  const cached = await env.KV.get(cacheKey, "json");
  if (cached) return normalizePostPilotGuide(slug, cached);

  const baseUrl = env.POSTPILOT_BASE_URL.replace(/\/$/, "");
  const res = await fetch(`${baseUrl}/v1/guides/${encodeURIComponent(slug)}`, {
    headers: { Accept: "application/json", "User-Agent": "BookGenerators/1.0 voice-import" },
  });
  if (!res.ok) throw new Error(`postpilot import failed: ${res.status}`);

  const json = await res.json();
  await env.KV.put(cacheKey, JSON.stringify(json), { expirationTtl: 24 * 60 * 60 });
  return normalizePostPilotGuide(slug, json);
}

async function loadPostPilotGuideIndex(env: Env) {
  const cacheKey = "postpilot:guides:index";
  const cached = await env.KV.get(cacheKey, "json");
  if (cached) return z.array(postPilotGuideIndexItemSchema).parse(cached);

  const baseUrl = env.POSTPILOT_BASE_URL.replace(/\/$/, "");
  const items: z.infer<typeof postPilotGuideIndexItemSchema>[] = [];
  let offset = 0;
  const limit = 100;

  for (let page = 0; page < 20; page += 1) {
    const url = new URL(`${baseUrl}/v1/guides`);
    url.searchParams.set("limit", String(limit));
    url.searchParams.set("offset", String(offset));
    const res = await fetch(url, {
      headers: { Accept: "application/json", "User-Agent": "BookGenerators/1.0 voice-index" },
    });
    if (!res.ok) throw new Error(`postpilot guide index failed: ${res.status}`);

    const json = postPilotGuideIndexSchema.parse(await res.json());
    items.push(...json.items);
    if (json.nextOffset == null) break;
    offset = json.nextOffset;
  }

  items.sort((a, b) => a.author.localeCompare(b.author));
  await env.KV.put(cacheKey, JSON.stringify(items), { expirationTtl: 60 * 60 });
  return items;
}

async function persistSample(
  env: Env,
  db: ReturnType<typeof drizzle>,
  voiceId: string,
  input: SampleInput,
) {
  const text = await loadSampleText(input);
  const sampleId = crypto.randomUUID();
  const safeName = input.filename?.replace(/[^a-z0-9._-]/gi, "-").slice(0, 80);
  const ext = safeName?.split(".").pop() || "txt";
  const r2Key = `voices/${voiceId}/samples/${sampleId}.${ext}`;

  await env.R2.put(r2Key, text, {
    httpMetadata: { contentType: "text/plain; charset=utf-8" },
    customMetadata: { source: input.source },
  });
  await db.insert(voice_samples).values({
    id: sampleId,
    voice_id: voiceId,
    r2_key: r2Key,
    source: input.source,
    word_count: countWords(text),
  });
}

async function refreshProfile(env: Env, db: ReturnType<typeof drizzle>, voiceId: string) {
  const samples = await db
    .select({ r2_key: voice_samples.r2_key })
    .from(voice_samples)
    .where(eq(voice_samples.voice_id, voiceId));
  const texts = await Promise.all(
    samples.map(async (sample) => (await env.R2.get(sample.r2_key))?.text() ?? ""),
  );
  const profile = await synthesizeVoiceProfile(env, texts.join("\n\n"));
  await db
    .update(voices)
    .set({
      profile_md: profile.profile_md,
      profile_json: profile.profile_json,
      updated_at: new Date(),
    })
    .where(eq(voices.id, voiceId));
}
