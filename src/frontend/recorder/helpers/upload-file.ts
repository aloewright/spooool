import { uploadInChunks } from "../../lib/chunked-upload";
import { getExtension } from "./find-good-supported-codec";

export const parseJsonOrThrowSource = (data: Uint8Array, type: string) => {
  const asString = new TextDecoder("utf-8").decode(data);
  try {
    return JSON.parse(asString);
  } catch {
    throw new Error(`Invalid JSON (${type}): ${asString}`);
  }
};

const ID_PATTERN = /^[A-Za-z0-9_-]{1,64}$/;

function sanitizeId(raw: string, fallback: string): string {
  const cleaned = raw.replace(/[^A-Za-z0-9_-]/g, "_").slice(0, 64);
  return cleaned.length > 0 && ID_PATTERN.test(cleaned) ? cleaned : fallback;
}

export interface UploadFileToServerArgs {
  blob: Blob;
  endDate: number;
  prefix: string;
  selectedFolder: string;
  expectedFrames: number;
  mimeType: string;
}

export interface UploadFileResult {
  r2Key: string;
}

export const uploadFileToServer = async (
  args: UploadFileToServerArgs,
): Promise<UploadFileResult> => {
  const extension = getExtension(args.mimeType);
  const sessionId = sanitizeId(args.selectedFolder, "default");
  const takeId = sanitizeId(
    `${args.prefix}${args.endDate}`,
    `take_${args.endDate}`,
  );

  const file = new File([args.blob], `${takeId}.${extension}`, {
    type: args.mimeType,
  });

  const result = await uploadInChunks({
    file,
    endpoint: "/api/videos/upload",
    target: "recorder",
    fields: { sessionId, takeId },
    filename: `${takeId}.${extension}`,
    onProgress: () => {
      // No UI hookup yet — the recorder's existing UI shows its own progress
      // based on local recording state. Per-chunk percentage can be wired in
      // a later polish task.
    },
  });

  if (!result.ok) throw new Error("Upload failed");

  const body = (await result.lastResponse.json()) as { r2Key?: string };
  if (!body.r2Key) {
    throw new Error("Upload response missing r2Key");
  }
  return { r2Key: body.r2Key };
};
