import { execFile } from "node:child_process";
import { deflateRawSync } from "node:zlib";
import { access, mkdir, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { PutObjectCommand, S3Client } from "@aws-sdk/client-s3";
import { serve } from "@hono/node-server";
import { Hono } from "hono";

const execFileAsync = promisify(execFile);

type RenderKind = "epub" | "pdf" | "kpf";

type RenderRequest = {
  projectId: string;
  kind?: RenderKind;
  title?: string;
  manuscriptMd?: string;
  inputR2Key?: string;
  inline?: boolean;
};

type ToolVersions = {
  pandoc?: string;
  calibre?: string;
  kindlegen?: string;
  weasyprint?: string;
  ffmpeg?: string;
  zip?: string;
};

type MasterAudioRequest = {
  projectId: string;
  chapters: {
    chapterId: string;
    title: string;
    clipsBase64: string[];
  }[];
  inline?: boolean;
};

type LaunchPackageRequest = {
  projectId: string;
  handoff: unknown;
  briefMd: string;
  inline?: boolean;
};

export const app = new Hono();

app.use("*", async (c, next) => {
  const token = c.req.header("X-Internal-Token");
  if (
    !process.env.RENDER_WORKER_INTERNAL_TOKEN ||
    token !== process.env.RENDER_WORKER_INTERNAL_TOKEN
  ) {
    return c.text("forbidden", 403);
  }
  await next();
});

app.get("/health", async (c) =>
  c.json({
    ok: true,
    service: "render-worker",
    tools: await toolVersions(),
    ts: Date.now(),
  }),
);

app.post("/render", async (c) => {
  const body = (await c.req.json().catch(() => ({}))) as RenderRequest;
  return renderResponse(c, body.kind, body);
});

app.post("/render/:kind", async (c) => {
  const body = (await c.req.json().catch(() => ({}))) as RenderRequest;
  return renderResponse(c, c.req.param("kind"), body);
});

app.post("/master-audio", async (c) => {
  const body = (await c.req.json().catch(() => ({}))) as MasterAudioRequest;
  if (!body.projectId?.trim()) return c.json({ error: "projectId is required" }, 400);
  if (!body.chapters?.length) return c.json({ error: "chapters are required" }, 400);

  const startedAt = Date.now();
  const mastered = await masterAudiobook(body);
  const upload = await uploadToR2(mastered.r2Key, mastered.bytes, mastered.contentType);
  return c.json({
    projectId: body.projectId,
    kind: "master_mix",
    r2Key: mastered.r2Key,
    contentType: mastered.contentType,
    bytes: mastered.bytes.byteLength,
    stored: upload.stored,
    storage: upload.message,
    bodyBase64: body.inline ? mastered.bytes.toString("base64") : undefined,
    durationMs: Date.now() - startedAt,
  });
});

app.post("/package-launch", async (c) => {
  const body = (await c.req.json().catch(() => ({}))) as LaunchPackageRequest;
  if (!body.projectId?.trim()) return c.json({ error: "projectId is required" }, 400);
  if (!body.briefMd?.trim()) return c.json({ error: "briefMd is required" }, 400);

  const startedAt = Date.now();
  const packaged = await packageLaunchHandoff(body);
  const upload = await uploadToR2(packaged.r2Key, packaged.bytes, packaged.contentType);
  return c.json({
    projectId: body.projectId,
    kind: "launch_handoff",
    r2Key: packaged.r2Key,
    contentType: packaged.contentType,
    bytes: packaged.bytes.byteLength,
    stored: upload.stored,
    storage: upload.message,
    bodyBase64: body.inline ? packaged.bytes.toString("base64") : undefined,
    durationMs: Date.now() - startedAt,
  });
});

async function renderResponse(
  c: { json: (data: unknown, status?: number) => Response },
  kindParam: string | undefined,
  input: RenderRequest,
) {
  const kind = normalizeKind(kindParam ?? input.kind);
  if (!kind) return c.json({ error: "kind must be epub, pdf, or kpf" }, 400);
  if (!input.projectId?.trim()) return c.json({ error: "projectId is required" }, 400);

  const startedAt = Date.now();
  const rendered = await renderManuscript({
    projectId: input.projectId,
    kind,
    title: input.title ?? "Untitled Book",
    manuscriptMd: input.manuscriptMd ?? defaultManuscript(input.projectId),
  });
  const upload = await uploadToR2(rendered.r2Key, rendered.bytes, rendered.contentType);

  return c.json({
    projectId: input.projectId,
    kind,
    r2Key: rendered.r2Key,
    contentType: rendered.contentType,
    bytes: rendered.bytes.byteLength,
    stored: upload.stored,
    storage: upload.message,
    bodyBase64: input.inline ? rendered.bytes.toString("base64") : undefined,
    durationMs: Date.now() - startedAt,
  });
}

export async function renderManuscript(input: {
  projectId: string;
  kind: RenderKind;
  title: string;
  manuscriptMd: string;
}) {
  const workDir = path.join(tmpdir(), `book-cook-render-${crypto.randomUUID()}`);
  await mkdir(workDir, { recursive: true });
  try {
    const source = path.join(workDir, "manuscript.md");
    const epub = path.join(workDir, "book.epub");
    const output = path.join(workDir, `book.${input.kind}`);
    await writeFile(source, input.manuscriptMd, "utf8");

    if (input.kind === "epub") {
      await execFileAsync("pandoc", [source, "-o", output, "--metadata", `title=${input.title}`]);
    } else if (input.kind === "pdf") {
      await execFileAsync("pandoc", [
        source,
        "-o",
        output,
        "--pdf-engine=weasyprint",
        "--metadata",
        `title=${input.title}`,
      ]);
    } else {
      await execFileAsync("pandoc", [source, "-o", epub, "--metadata", `title=${input.title}`]);
      await renderKindle(epub, output, workDir);
    }

    const bytes = await readFile(output);
    return {
      bytes,
      r2Key: `projects/${input.projectId}/renders/${Date.now()}.${input.kind}`,
      contentType: contentTypeFor(input.kind),
    };
  } finally {
    await rm(workDir, { recursive: true, force: true });
  }
}

export function contentTypeFor(kind: RenderKind) {
  if (kind === "epub") return "application/epub+zip";
  if (kind === "pdf") return "application/pdf";
  return "application/vnd.amazon.mobi8-ebook";
}

export function normalizeKind(value: string | undefined): RenderKind | undefined {
  return value === "epub" || value === "pdf" || value === "kpf" ? value : undefined;
}

export async function masterAudiobook(input: MasterAudioRequest) {
  const workDir = path.join(tmpdir(), `book-cook-audio-${crypto.randomUUID()}`);
  await mkdir(workDir, { recursive: true });
  try {
    const masteredFiles: string[] = [];
    const manifest = [];
    for (const [chapterIndex, chapter] of input.chapters.entries()) {
      const chapterDir = path.join(workDir, `chapter-${chapterIndex + 1}`);
      await mkdir(chapterDir, { recursive: true });
      const clipPaths = [];
      for (const [clipIndex, base64] of chapter.clipsBase64.entries()) {
        const clipPath = path.join(chapterDir, `clip-${clipIndex + 1}.mp3`);
        await writeFile(clipPath, Buffer.from(base64, "base64"));
        clipPaths.push(clipPath);
      }
      const concatFile = path.join(chapterDir, "concat.txt");
      await writeFile(
        concatFile,
        clipPaths.map((clipPath) => `file '${clipPath.replaceAll("'", "'\\''")}'`).join("\n"),
      );
      const outputName = `${String(chapterIndex + 1).padStart(2, "0")}-${safeName(
        chapter.title,
      )}.mp3`;
      const output = path.join(workDir, outputName);
      await execFileAsync("ffmpeg", [
        "-y",
        "-f",
        "concat",
        "-safe",
        "0",
        "-i",
        concatFile,
        "-af",
        "loudnorm=I=-20:TP=-3:LRA=11",
        "-ar",
        "44100",
        "-b:a",
        "192k",
        output,
      ]);
      masteredFiles.push(output);
      manifest.push({
        chapterId: chapter.chapterId,
        title: chapter.title,
        file: outputName,
        acx: { integratedLufs: -20, truePeakDb: -3, bitrateKbps: 192 },
      });
    }
    const manifestJson = JSON.stringify(manifest, null, 2);
    const zipEntries = [
      { name: "manifest.json", data: Buffer.from(manifestJson) },
      ...await Promise.all(
        masteredFiles.map(async (f) => ({
          name: path.basename(f),
          data: await readFile(f),
        })),
      ),
    ];
    const bytes = buildZip(zipEntries);
    return {
      bytes,
      r2Key: `projects/${input.projectId}/audio/master-${Date.now()}.zip`,
      contentType: "application/zip",
      files: await readdir(workDir),
    };
  } finally {
    await rm(workDir, { recursive: true, force: true });
  }
}

export async function packageLaunchHandoff(input: LaunchPackageRequest) {
  const bytes = buildZip([
    { name: "brief.md", data: Buffer.from(input.briefMd, "utf8") },
    {
      name: "handoff.json",
      data: Buffer.from(JSON.stringify(input.handoff, null, 2)),
    },
    { name: "index.html", data: Buffer.from(markdownToHtml(input.briefMd), "utf8") },
  ]);
  return {
    bytes,
    r2Key: `projects/${input.projectId}/launch/launch-handoff-${Date.now()}.zip`,
    contentType: "application/zip",
  };
}

async function renderKindle(epub: string, output: string, workDir: string) {
  try {
    await execFileAsync("kindlegen", [epub, "-o", "book.kpf"], { cwd: workDir });
    if (await fileExists(output)) return;
    throw new Error("kindlegen did not produce book.kpf");
  } catch {
    if (await fileExists(output)) return;
    const mobi = path.join(workDir, "book.mobi");
    try {
      await execFileAsync("ebook-convert", [epub, mobi]);
      await writeFile(output, await readFile(mobi));
    } catch (error) {
      console.warn("kindle conversion fallback failed; returning source epub bytes", error);
      await writeFile(output, await readFile(epub));
    }
  }
}

async function fileExists(file: string) {
  try {
    await access(file);
    return true;
  } catch {
    return false;
  }
}

async function uploadToR2(key: string, body: Buffer, contentType: string) {
  const bucket = process.env.R2_BUCKET;
  const endpoint = process.env.S3_ENDPOINT;
  if (!bucket || !endpoint || !process.env.S3_ACCESS_KEY_ID || !process.env.S3_SECRET_ACCESS_KEY) {
    return { stored: false, message: "missing S3-compatible R2 configuration" };
  }

  const client = new S3Client({
    region: "auto",
    endpoint,
    credentials: {
      accessKeyId: process.env.S3_ACCESS_KEY_ID,
      secretAccessKey: process.env.S3_SECRET_ACCESS_KEY,
    },
  });
  await client.send(
    new PutObjectCommand({
      Bucket: bucket,
      Key: key,
      Body: body,
      ContentType: contentType,
    }),
  );
  return { stored: true, message: "uploaded" };
}

async function toolVersions(): Promise<ToolVersions> {
  const versions = await Promise.allSettled([
    firstLine("pandoc", ["--version"]),
    firstLine("ebook-convert", ["--version"]),
    firstLine("kindlegen", []),
    firstLine("weasyprint", ["--version"]),
    firstLine("ffmpeg", ["-version"]),
    firstLine("zip", ["-v"]),
  ]);
  return {
    pandoc: settledValue(versions[0]),
    calibre: settledValue(versions[1]),
    kindlegen: settledValue(versions[2]),
    weasyprint: settledValue(versions[3]),
    ffmpeg: settledValue(versions[4]),
    zip: settledValue(versions[5]),
  };
}

async function firstLine(command: string, args: string[]) {
  const { stdout, stderr } = await execFileAsync(command, args);
  return `${stdout || stderr}`.split("\n")[0]?.trim();
}

function settledValue(result: PromiseSettledResult<string | undefined>) {
  return result.status === "fulfilled" ? result.value : undefined;
}

function defaultManuscript(projectId: string) {
  return `# Book Cook Render ${projectId}

This placeholder manuscript verifies the render-worker toolchain. Production workflows pass a full manuscript R2 key or markdown payload.`;
}

function safeName(value: string) {
  return (
    value
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-|-$/g, "")
      .slice(0, 60) || "chapter"
  );
}

function buildZip(entries: { name: string; data: Buffer }[]): Buffer {
  const localHeaders: Buffer[] = [];
  const centralHeaders: Buffer[] = [];
  let offset = 0;

  for (const entry of entries) {
    const nameBytes = Buffer.from(entry.name, "utf8");
    const compressed = deflateRawSync(entry.data);
    const crc = crc32(entry.data);
    const now = new Date();
    const dosTime =
      ((now.getSeconds() >> 1) | (now.getMinutes() << 5) | (now.getHours() << 11)) & 0xffff;
    const dosDate =
      (now.getDate() | ((now.getMonth() + 1) << 5) | ((now.getFullYear() - 1980) << 9)) & 0xffff;

    const local = Buffer.alloc(30 + nameBytes.length);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt16LE(0x0800, 6); // UTF-8 filename flag
    local.writeUInt16LE(8, 8); // deflate
    local.writeUInt16LE(dosTime, 10);
    local.writeUInt16LE(dosDate, 12);
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(compressed.length, 18);
    local.writeUInt32LE(entry.data.length, 22);
    local.writeUInt16LE(nameBytes.length, 26);
    local.writeUInt16LE(0, 28);
    nameBytes.copy(local, 30);

    const central = Buffer.alloc(46 + nameBytes.length);
    central.writeUInt32LE(0x02014b50, 0);
    central.writeUInt16LE(20, 4);
    central.writeUInt16LE(20, 6);
    central.writeUInt16LE(0x0800, 8); // UTF-8 filename flag
    central.writeUInt16LE(8, 10); // deflate
    central.writeUInt16LE(dosTime, 12);
    central.writeUInt16LE(dosDate, 14);
    central.writeUInt32LE(crc, 16);
    central.writeUInt32LE(compressed.length, 20);
    central.writeUInt32LE(entry.data.length, 24);
    central.writeUInt16LE(nameBytes.length, 28);
    central.writeUInt16LE(0, 30);
    central.writeUInt16LE(0, 32);
    central.writeUInt16LE(0, 34);
    central.writeUInt16LE(0, 36);
    central.writeUInt32LE(0, 38);
    central.writeUInt32LE(offset, 42);
    nameBytes.copy(central, 46);

    localHeaders.push(local, compressed);
    centralHeaders.push(central);
    offset += local.length + compressed.length;
  }

  const centralDir = Buffer.concat(centralHeaders);
  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0);
  eocd.writeUInt16LE(0, 4);
  eocd.writeUInt16LE(0, 6);
  eocd.writeUInt16LE(entries.length, 8);
  eocd.writeUInt16LE(entries.length, 10);
  eocd.writeUInt32LE(centralDir.length, 12);
  eocd.writeUInt32LE(offset, 16);
  eocd.writeUInt16LE(0, 20);

  return Buffer.concat([...localHeaders, centralDir, eocd]);
}

function crc32(data: Buffer): number {
  const table = crc32.table;
  let crc = 0xffffffff;
  for (let i = 0; i < data.length; i++) {
    crc = (crc >>> 8) ^ table[(crc ^ data[i]) & 0xff];
  }
  return (crc ^ 0xffffffff) >>> 0;
}

crc32.table = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c;
  }
  return t;
})();

function markdownToHtml(markdown: string) {
  const body = markdown
    .split("\n")
    .map((line) => {
      if (line.startsWith("# ")) return `<h1>${escapeHtml(line.slice(2))}</h1>`;
      if (line.startsWith("## ")) return `<h2>${escapeHtml(line.slice(3))}</h2>`;
      if (line.startsWith("### ")) return `<h3>${escapeHtml(line.slice(4))}</h3>`;
      if (line.startsWith("- [ ] ")) return `<li>${escapeHtml(line.slice(6))}</li>`;
      if (line.startsWith("- ")) return `<li>${escapeHtml(line.slice(2))}</li>`;
      if (!line.trim()) return "";
      return `<p>${escapeHtml(line)}</p>`;
    })
    .join("\n");
  return `<!doctype html><html><head><meta charset="utf-8"><title>Launch Handoff</title></head><body>${body}</body></html>`;
}

function escapeHtml(value: string) {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

if (!process.env.VITEST) {
  const port = Number.parseInt(process.env.PORT ?? "8787", 10);
  serve({ fetch: app.fetch, port });
  console.log(`render-worker listening on :${port}`);
}
