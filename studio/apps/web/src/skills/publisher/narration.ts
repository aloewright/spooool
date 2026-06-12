export type NarrationChapter = {
  title: string;
  summary: string;
  draft_md: string;
};

export type NarrationChunk = {
  chapterTitle: string;
  ordinal: number;
  ssml: string;
  text: string;
};

export type NarrationScript = {
  chunks: NarrationChunk[];
  sampleText: string;
};

const MAX_CHUNK_CHARS = 4500;
const SAMPLE_LIMIT = 900;

export function buildNarrationScript(chapters: NarrationChapter[]): NarrationScript {
  const chunks = chapters.flatMap((chapter, chapterIndex) => {
    const body = normalizeNarrationText(chapter.draft_md || chapter.summary || chapter.title);
    return chunkText(body, MAX_CHUNK_CHARS - 200).map((text, index) => ({
      chapterTitle: chapter.title,
      ordinal: index + 1,
      text,
      ssml: toSsml(chapter.title, text, chapterIndex === 0 && index === 0),
    }));
  });

  return {
    chunks,
    sampleText: sampleAuditionText(chunks),
  };
}

export function normalizeNarrationText(markdown: string) {
  return markdown
    .replace(/```[\s\S]*?```/g, " ")
    .replace(/`([^`]+)`/g, "$1")
    .replace(/!\[[^\]]*]\([^)]*\)/g, " ")
    .replace(/\[([^\]]+)]\([^)]*\)/g, "$1")
    .replace(/^#{1,6}\s+/gm, "")
    .replace(/^[-*]\s+/gm, "")
    .replace(/\*\*([^*]+)\*\*/g, "$1")
    .replace(/\*([^*]+)\*/g, "$1")
    .replace(/\bDr\./g, "Doctor")
    .replace(/\bMr\./g, "Mister")
    .replace(/\bMrs\./g, "Misses")
    .replace(/\bMs\./g, "Miz")
    .replace(/\s+/g, " ")
    .trim();
}

function sampleAuditionText(chunks: NarrationChunk[]) {
  const joined = chunks.map((chunk) => chunk.text).join("\n\n");
  if (joined.length <= SAMPLE_LIMIT) return joined;
  const boundary = joined.lastIndexOf(".", SAMPLE_LIMIT);
  return joined.slice(0, boundary > 240 ? boundary + 1 : SAMPLE_LIMIT).trim();
}

function chunkText(text: string, maxChars: number) {
  if (!text) return [];
  const sentences = text.match(/[^.!?]+[.!?]+|[^.!?]+$/g) ?? [text];
  const chunks: string[] = [];
  let current = "";
  for (const sentence of sentences.map((item) => item.trim()).filter(Boolean)) {
    if (current && `${current} ${sentence}`.length > maxChars) {
      chunks.push(current);
      current = sentence;
    } else {
      current = current ? `${current} ${sentence}` : sentence;
    }
  }
  if (current) chunks.push(current);
  return chunks;
}

function toSsml(chapterTitle: string, text: string, includeTitle: boolean) {
  const withDialogueEmphasis = escapeXml(text).replace(
    /&quot;([^&]+?)&quot;/g,
    '&quot;<emphasis level="moderate">$1</emphasis>&quot;',
  );
  const title = includeTitle ? `<p>${escapeXml(chapterTitle)}</p><break time="700ms"/>` : "";
  return `<speak>${title}<p>${withDialogueEmphasis}</p><break time="500ms"/></speak>`;
}

function escapeXml(input: string) {
  return input
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}
