export type ProjectKind = "fiction" | "nonfiction";

export type FrameworkChapter = {
  title: string;
  summary: string;
  target_words: number;
  sections: {
    kind: string;
    prompt: string;
    target_words: number;
    beat: string;
  }[];
};

export type CharacterArcGuidance = {
  name: string;
  arc: string;
  position: string;
  sceneRole?: string;
};

export type ScenePlanGuidance = {
  defaultCast?: string;
  miniStructure?: string;
};

export type ChapterPlanGuidance = {
  ordinal: number;
  title?: string;
  event: string;
  purpose?: string;
  pov?: string;
  characters?: string;
};

export type FrameworkOutline = {
  framework: string;
  acts: {
    title: string;
    chapters: FrameworkChapter[];
  }[];
};

export type Framework = {
  id: string;
  label: string;
  type: ProjectKind | "any";
  questions: string[];
  build(input: {
    title: string;
    genre?: string | null;
    targetWordCount: number;
    questionnaire: string;
    voiceSummary?: string;
    characterArcs?: CharacterArcGuidance[];
    scenePlan?: ScenePlanGuidance;
    chapterPlan?: ChapterPlanGuidance[];
  }): FrameworkOutline;
};

export function splitWords(value: string) {
  return value
    .split(/\s+/)
    .map((word) => word.trim())
    .filter(Boolean);
}

export function chapterTarget(total: number, chapters: number) {
  return Math.max(1200, Math.round(total / chapters));
}

export function chapter(
  title: string,
  summary: string,
  targetWords: number,
  sections: {
    kind: string;
    prompt: string;
    share: number;
    beat: string;
  }[],
): FrameworkChapter {
  return {
    title,
    summary,
    target_words: targetWords,
    sections: sections.map((section) => ({
      kind: section.kind,
      prompt: section.prompt,
      target_words: Math.round(targetWords * section.share),
      beat: section.beat,
    })),
  };
}

export function voiceDirection(voiceSummary?: string) {
  return voiceSummary ? ` Voice direction: ${voiceSummary}` : "";
}

export function fictionGuidance(input: {
  characterArcs?: CharacterArcGuidance[];
  scenePlan?: ScenePlanGuidance;
}) {
  const characters = (input.characterArcs ?? [])
    .filter((character) => character.name.trim())
    .map((character) =>
      [
        character.name.trim(),
        character.arc.trim() ? `arc: ${character.arc.trim()}` : "",
        character.position.trim() ? `current position: ${character.position.trim()}` : "",
        character.sceneRole?.trim() ? `scene role: ${character.sceneRole.trim()}` : "",
      ]
        .filter(Boolean)
        .join("; "),
    );

  const characterText = characters.length ? ` Character arc map: ${characters.join(" | ")}.` : "";
  const castText = input.scenePlan?.defaultCast?.trim()
    ? ` Default scene cast guidance: ${input.scenePlan.defaultCast.trim()}.`
    : "";
  const miniStructure =
    input.scenePlan?.miniStructure?.trim() ||
    "Use a three-part mini-scene structure: setup the scene goal and conflict, force a turn or reversal, then close with a consequence that changes the next scene.";

  return `${characterText}${castText} Scene structure: ${miniStructure}`;
}
