import type { Dispatch, SetStateAction } from "react";
import type { PostPilotGuide, Project, PublisherPack } from "../../lib/api";
import type { WorkflowKey, WorkflowStatus } from "../workspace/outline-rail";

export const POSTPILOT_SUGGESTIONS = [
  { slug: "dickens", author: "Charles Dickens", kicker: "Victorian" },
  { slug: "austen", author: "Jane Austen", kicker: "Regency" },
  { slug: "twain", author: "Mark Twain", kicker: "American realism" },
  { slug: "hemingway", author: "Ernest Hemingway", kicker: "Modernist" },
] as const;

export function postPilotGuideLabel(guide: Pick<PostPilotGuide, "author" | "kicker">) {
  return guide.kicker ? `${guide.author} · ${guide.kicker}` : guide.author;
}

export const FIELD_SLOT_IDS = ["one", "two", "three", "four", "five", "six", "seven"] as const;
export const CHARACTER_SLOT_IDS = [
  "char-one",
  "char-two",
  "char-three",
  "char-four",
  "char-five",
] as const;

export const CHARACTER_ARC_OPTIONS = [
  { value: "positive-change", label: "Positive Change" },
  { value: "flat", label: "Flat" },
  { value: "disillusionment", label: "Disillusionment" },
  { value: "fall", label: "Fall" },
  { value: "corruption", label: "Corruption" },
  { value: "redemption", label: "Redemption" },
  { value: "static-foil", label: "Static / Foil" },
] as const;

export type CharacterArcDraft = {
  id: string;
  name: string;
  arc: string;
  position: string;
  sceneRole: string;
};

export type ChapterPlanDraft = {
  id: string;
  title: string;
  event: string;
  purpose: string;
  pov: string;
  characters: string;
};

export const OUTLINE_FRAMEWORKS = [
  {
    id: "paas",
    type: "nonfiction",
    label: "Problem -> Agitate -> Solve",
    description: "Direct nonfiction argument for promise-led practical books.",
    questions: [
      "What painful problem does the reader want solved?",
      "What has the reader already tried?",
      "What promise can this book credibly make?",
      "What proof, stories, or examples can support the method?",
    ],
  },
  {
    id: "reader-transformation",
    type: "nonfiction",
    label: "Reader Transformation",
    description: "Nonfiction arc from current state to changed behavior.",
    questions: [
      "What is the reader's current state?",
      "What transformation should the book deliver?",
      "What method, proof, or case studies support the promise?",
      "What should the reader do differently after each chapter?",
    ],
  },
  {
    id: "hero-journey",
    type: "fiction",
    label: "Hero's Journey",
    description: "Classic quest structure for adventure-forward fiction.",
    questions: [
      "Who is the protagonist and what do they want?",
      "What wound or false belief keeps them stuck?",
      "What forces them out of the ordinary world?",
      "What choice proves they have changed?",
    ],
  },
  {
    id: "truby-22",
    type: "fiction",
    label: "Truby-style 22 Beats",
    description: "Dense cause-and-effect story architecture with moral pressure.",
    questions: [
      "What does the protagonist want on the surface?",
      "What deeper need or weakness must the plot expose?",
      "Who is the opponent and why are they morally persuasive?",
      "What final choice proves the protagonist has changed?",
    ],
  },
  {
    id: "character-arc",
    type: "fiction",
    label: "Character Arc",
    description: "K.M. Weiland-style want, need, lie, truth, and climactic choice.",
    questions: [
      "What lie or false belief drives the protagonist?",
      "What external want keeps them moving?",
      "What truth would make them whole?",
      "What pressure forces them to choose between the lie and the truth?",
    ],
  },
  {
    id: "thriller",
    type: "fiction",
    label: "Thriller Escalation",
    description: "Suspense-first outline with reversals, traps, and cliffhangers.",
    questions: [
      "What danger opens the book before anyone fully understands it?",
      "What personal stakes make retreat impossible?",
      "What does the antagonist know that the protagonist does not?",
      "What reversal changes the meaning of the investigation?",
    ],
  },
  {
    id: "sci-fi",
    type: "fiction",
    label: "Sci-Fi World + Idea",
    description: "Speculative premise, world rules, human cost, and ethical choice.",
    questions: [
      "What speculative premise changes ordinary life?",
      "What rule makes the world feel consistent?",
      "What human conflict keeps the idea emotional?",
      "What ethical choice should the ending force?",
    ],
  },
] as const;

export const WORKFLOW_COPY: Record<WorkflowKey, { title: string; description: string }> = {
  concept: {
    title: "Concept",
    description: "Confirm the book promise against market evidence before production work.",
  },
  voice: {
    title: "Voice",
    description: "Select or build the author voice that downstream drafting will use.",
  },
  outline: {
    title: "Outline",
    description: "Choose the story or nonfiction framework and decide the chapter plan.",
  },
  chapters: {
    title: "Chapters",
    description: "Review chapter purpose, draft status, and open the next chapter to write.",
  },
  book: {
    title: "Book",
    description: "Review the assembled manuscript and export production files.",
  },
  publish: {
    title: "Publish",
    description: "Prepare metadata, downloads, narration, and launch readiness.",
  },
  launch: {
    title: "Launch",
    description: "Create the go-to-market handoff once publishing assets are approved.",
  },
};

export type OutlineTab = "setup" | "decisions" | "characters" | "chapters";

export const OUTLINE_TABS: readonly { key: OutlineTab; label: string; description: string }[] = [
  {
    key: "setup",
    label: "Setup",
    description: "Framework and story brief.",
  },
  {
    key: "decisions",
    label: "Chapter board",
    description: "One chapter slot at a time.",
  },
  {
    key: "characters",
    label: "Characters",
    description: "Arc and scene context.",
  },
  {
    key: "chapters",
    label: "Generated",
    description: "Clickable skeletons.",
  },
];

export function workflowFromHash(): WorkflowKey {
  if (typeof window === "undefined") return "concept";
  const hash = window.location.hash.replace("#", "").split(":")[0];
  if (hash === "voice" || hash === "outline" || hash === "chapters" || hash === "publish") {
    return hash;
  }
  return "concept";
}

export function workflowChildFromHash() {
  if (typeof window === "undefined") return undefined;
  const [, child] = window.location.hash.replace("#", "").split(":");
  return child || undefined;
}

export function replaceWorkspaceHash(hash: string) {
  history.replaceState(null, "", `#${hash}`);
  window.dispatchEvent(new HashChangeEvent("hashchange"));
}

export function outlineTabFromWorkflowChild(child?: string): OutlineTab | undefined {
  if (
    child === "setup" ||
    child === "decisions" ||
    child === "characters" ||
    child === "chapters"
  ) {
    return child;
  }
  return undefined;
}

export function normalizeOutlineTab(
  tab: OutlineTab | undefined,
  type: Project["type"],
): OutlineTab {
  if (tab === "characters" && type !== "fiction") return "setup";
  return tab ?? "setup";
}

export function workflowStatuses({
  project,
  scoutCount,
  chapterCount,
  draftedChapterCount,
  publisherStatus,
}: {
  project: Project;
  scoutCount: number;
  chapterCount: number;
  draftedChapterCount: number;
  publisherStatus: PublisherPack["status"] | null;
}): Partial<Record<WorkflowKey, WorkflowStatus>> {
  return {
    concept: scoutCount > 0 ? "approved" : "in-progress",
    voice: project.voice_id ? "approved" : "not-started",
    outline: chapterCount > 0 ? "approved" : "not-started",
    chapters:
      chapterCount === 0
        ? "not-started"
        : draftedChapterCount === chapterCount
          ? "approved"
          : draftedChapterCount > 0
            ? "in-progress"
            : "needs-review",
    book: draftedChapterCount > 0 ? "in-progress" : "not-started",
    publish:
      publisherStatus === "approved"
        ? "approved"
        : publisherStatus === "draft"
          ? "needs-review"
          : "not-started",
    launch: publisherStatus === "approved" ? "in-progress" : "not-started",
  };
}

export function nextWorkflowAction({
  project,
  scoutCount,
  chapterCount,
  draftedChapterCount,
  publisherStatus,
}: {
  project: Project;
  scoutCount: number;
  chapterCount: number;
  draftedChapterCount: number;
  publisherStatus: PublisherPack["status"] | null;
}) {
  if (scoutCount === 0) return "Run Scout so the concept has evidence before outlining.";
  if (!project.voice_id) return "Select or create the voice that should guide the manuscript.";
  if (chapterCount === 0) return "Build the outline and chapter decision board.";
  if (draftedChapterCount < chapterCount)
    return "Draft the next planned chapter from the chapter list.";
  if (!publisherStatus) return "Generate publisher metadata from the completed manuscript.";
  if (publisherStatus === "draft") return "Review and approve the publisher pack.";
  return "Open Launch and prepare the handoff package.";
}

export function parseVoiceIds(value: string) {
  return value
    .split(/[,\n]/)
    .map((item) => item.trim())
    .filter(Boolean)
    .slice(0, 3);
}

export function sanitizePublisherDescription(value: string) {
  return value
    .replace(/<(?!\/?(p|strong|em|ul|li|br)\b)[^>]*>/gi, "")
    .replace(/\son\w+\s*=\s*("[^"]*"|'[^']*'|[^\s>]+)/gi, "");
}

export function validateDraftPack(pack: PublisherPack) {
  const errors: string[] = [];
  if (!pack.title.trim()) errors.push("Title is required.");
  if (pack.description_html.length > 4000) errors.push("Description is over 4000 characters.");
  if (pack.keywords.length !== 7 || pack.keywords.some((item) => !item.trim())) {
    errors.push("Fill all 7 keywords.");
  }
  if (pack.keywords.some((item) => item.length > 50)) {
    errors.push("Each keyword must be 50 characters or fewer.");
  }
  if (pack.bisac.length !== 2 || pack.bisac.some((item) => !item.trim())) {
    errors.push("Fill both BISAC categories.");
  }
  return errors;
}

export function updateCharacter(
  setCharacters: Dispatch<SetStateAction<CharacterArcDraft[]>>,
  id: string,
  patch: Partial<CharacterArcDraft>,
) {
  setCharacters((current) =>
    current.map((character) => (character.id === id ? { ...character, ...patch } : character)),
  );
}

export function createChapterPlanDrafts(count: number) {
  return Array.from({ length: count }, (_, index) => createChapterPlanDraft(index + 1));
}

export function createChapterPlanDraft(ordinal: number): ChapterPlanDraft {
  return {
    id: `chapter-plan-${ordinal}`,
    title: "",
    event: "",
    purpose: "",
    pov: "",
    characters: "",
  };
}

export function updateChapterPlan(
  setChapterPlan: Dispatch<SetStateAction<ChapterPlanDraft[]>>,
  id: string,
  patch: Partial<ChapterPlanDraft>,
) {
  setChapterPlan((current) =>
    current.map((chapter) => (chapter.id === id ? { ...chapter, ...patch } : chapter)),
  );
}

export function characterArcLabel(value: string) {
  return CHARACTER_ARC_OPTIONS.find((option) => option.value === value)?.label ?? value;
}
