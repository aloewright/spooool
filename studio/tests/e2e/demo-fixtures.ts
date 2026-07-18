import type {
  Chapter,
  FullBookView,
  Project,
  PublisherPack,
  RenderJob,
  Section,
} from "../../apps/web/client/lib/api";

const DEMO_TIMESTAMP = 1_735_689_600_000;

export const project = {
  id: "demo-project",
  title: "The Cartographer's Lantern",
  type: "fiction",
  genre: "Fantasy",
  logline:
    "A mapmaker must redraw a city that changes each night before its last district disappears",
  audience_json: ["Readers of atmospheric fantasy and mysteries"],
  voice_styles_json: ["Luminous", "Precise", "Hopeful"],
  status: "drafted",
  voice_id: null,
  created_at: DEMO_TIMESTAMP,
  updated_at: DEMO_TIMESTAMP,
  deleted_at: null,
} satisfies Project;

export const chapters = [
  {
    id: "chapter-1",
    project_id: project.id,
    ordinal: 1,
    title: "The Vanishing Ward",
    summary: "Mara discovers that the Lantern Ward has disappeared from every city map.",
    status: "drafted",
    target_words: 1_200,
    draft_md:
      "Mara woke before the bells and found a blank space where the Lantern Ward should have been.",
    created_at: DEMO_TIMESTAMP,
    updated_at: DEMO_TIMESTAMP,
  },
  {
    id: "chapter-2",
    project_id: project.id,
    ordinal: 2,
    title: "Ink at Midnight",
    summary: "A surviving street appears only when Mara redraws it by lantern light.",
    status: "drafted",
    target_words: 1_200,
    draft_md:
      "At midnight, the ink in Mara's atlas began to move toward a street that no longer existed.",
    created_at: DEMO_TIMESTAMP,
    updated_at: DEMO_TIMESTAMP,
  },
  {
    id: "chapter-3",
    project_id: project.id,
    ordinal: 3,
    title: "The Last District",
    summary: "Mara restores the city by choosing what the final map will remember.",
    status: "drafted",
    target_words: 1_200,
    draft_md:
      "With the final district fading beneath her pen, Mara drew a door for every lost home.",
    created_at: DEMO_TIMESTAMP,
    updated_at: DEMO_TIMESTAMP,
  },
] satisfies Chapter[];

export const sectionsByChapter: Record<string, Section[]> = {
  "chapter-1": [
    {
      id: "section-1",
      chapter_id: "chapter-1",
      ordinal: 1,
      kind: "scene",
      prompt: "Show Mara finding the missing ward on her map before dawn.",
      draft_md:
        "The first absence appeared between the river and the observatory: a clean white wound in the paper.",
      beginning_md: "Mara opens the city atlas before dawn.",
      middle_md: "The Lantern Ward has vanished from the page.",
      end_md: "A single lamp flickers inside the blank space.",
      status: "drafted",
      created_at: DEMO_TIMESTAMP,
      updated_at: DEMO_TIMESTAMP,
    },
  ],
  "chapter-2": [
    {
      id: "section-2",
      chapter_id: "chapter-2",
      ordinal: 1,
      kind: "scene",
      prompt: "Let Mara test the map's shifting ink at midnight.",
      draft_md:
        "When the clock struck twelve, a blue line threaded itself from Mara's pen to the river.",
      beginning_md: "Mara waits beside the atlas after midnight.",
      middle_md: "The ink draws a route through the missing ward.",
      end_md: "The route ends at a door that was not there before.",
      status: "drafted",
      created_at: DEMO_TIMESTAMP,
      updated_at: DEMO_TIMESTAMP,
    },
  ],
  "chapter-3": [],
};

export const publisherPack = {
  id: "demo-publisher-pack",
  title: project.title,
  subtitle: "A city that redraws itself after dark",
  series_name: "The Lantern Atlas",
  description_html:
    "<p>A mapmaker races to redraw a city that changes each night before its last district disappears.</p>",
  keywords: ["fantasy mystery", "magical city", "cartographer fantasy"],
  bisac: ["FICTION / Fantasy / Urban", "FICTION / Mystery & Detective / Women Sleuths"],
  status: "approved",
} satisfies PublisherPack;

export const renderJobs = [
  {
    id: "demo-pdf-render",
    project_id: project.id,
    kind: "pdf",
    status: "completed",
    workflow_id: "demo-pdf-workflow",
    output_r2_key: "exports/demo-project/the-cartographers-lantern.pdf",
    error: null,
    started_at: DEMO_TIMESTAMP,
    completed_at: DEMO_TIMESTAMP,
    cost_cents: 0,
    download_url: "/api/v1/projects/demo-project/export/jobs/demo-pdf-render/download",
  },
] satisfies RenderJob[];

export const fullBook = {
  title: project.title,
  chapters: chapters.map((chapter) => ({
    id: chapter.id,
    ordinal: chapter.ordinal,
    title: chapter.title,
    summary: chapter.summary,
    body_md: chapter.draft_md,
    word_count: chapter.draft_md.split(/\s+/).length,
    has_draft: true,
  })),
  manuscript_md: chapters.map((chapter) => `# ${chapter.title}\n\n${chapter.draft_md}`).join("\n\n"),
  total_words: chapters.reduce(
    (total, chapter) => total + chapter.draft_md.split(/\s+/).length,
    0,
  ),
  drafted_chapters: chapters.length,
} satisfies FullBookView;
