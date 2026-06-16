export type ExportKind = "epub" | "pdf" | "kpf";
export const exportKinds: ExportKind[] = ["epub", "pdf", "kpf"];
export const downloadableBookKinds: ExportKind[] = ["epub", "pdf"];

export type ManuscriptChapterInput = {
  id?: string;
  ordinal: number;
  title: string;
  summary: string;
  draft_md: string;
};

export type FullBookChapter = {
  id?: string;
  ordinal: number;
  title: string;
  summary: string;
  body_md: string;
  word_count: number;
  has_draft: boolean;
};

export type FullBookView = {
  title: string;
  chapters: FullBookChapter[];
  manuscript_md: string;
  total_words: number;
  drafted_chapters: number;
};

export function normalizeExportKinds(input?: string[] | null): ExportKind[] {
  const requested = (input ?? []).filter((kind): kind is ExportKind =>
    exportKinds.includes(kind as ExportKind),
  );
  return requested.length ? Array.from(new Set(requested)) : exportKinds;
}

export function manuscriptMarkdown(title: string, rows: ManuscriptChapterInput[]): string {
  const chaptersMd = rows
    .map((chapter) => {
      const body = chapter.draft_md.trim() || chapter.summary.trim();
      return `# ${chapter.ordinal}. ${chapter.title}\n\n${body || "_No draft text yet._"}`;
    })
    .join("\n\n");
  return `% ${title}\n\n${chaptersMd}\n`;
}

export function fullBookView(title: string, rows: ManuscriptChapterInput[]): FullBookView {
  const chapters = rows.map((chapter) => {
    const draft = chapter.draft_md.trim();
    const body = draft || chapter.summary.trim() || "_No draft text yet._";
    return {
      id: chapter.id,
      ordinal: chapter.ordinal,
      title: chapter.title,
      summary: chapter.summary,
      body_md: body,
      word_count: wordCount(body),
      has_draft: Boolean(draft),
    };
  });

  return {
    title,
    chapters,
    manuscript_md: manuscriptMarkdown(title, rows),
    total_words: chapters.reduce((sum, chapter) => sum + chapter.word_count, 0),
    drafted_chapters: chapters.filter((chapter) => chapter.has_draft).length,
  };
}

function wordCount(value: string) {
  return value.trim().split(/\s+/).filter(Boolean).length;
}
