import { type Framework, chapter, chapterTarget, fictionGuidance, voiceDirection } from "./shared";

const BEATS = [
  "The lie they believe",
  "The thing they want",
  "The thing they need",
  "Normal world pressure",
  "Inciting event",
  "First plot point",
  "First pinch point",
  "Midpoint truth",
  "Second pinch point",
  "Third plot point",
  "Climactic choice",
  "Changed-world resolution",
] as const;

export const characterArcFramework: Framework = {
  id: "character-arc",
  label: "Character Arc",
  type: "fiction",
  questions: [
    "What lie or false belief drives the protagonist?",
    "What external want keeps them moving?",
    "What truth would make them whole?",
    "What pressure forces them to choose between the lie and the truth?",
  ],
  build({ title, genre, targetWordCount, questionnaire, voiceSummary, characterArcs, scenePlan }) {
    const perChapter = chapterTarget(targetWordCount, BEATS.length);
    const context = questionnaire || `A ${genre || "fiction"} story titled ${title}.`;
    const guidance = `${voiceDirection(voiceSummary)}${fictionGuidance({ characterArcs, scenePlan })}`;
    return {
      framework: "character-arc",
      acts: [
        {
          title: "Lie",
          chapters: BEATS.slice(0, 4).map((beat) =>
            arcChapter(beat, context, perChapter, guidance),
          ),
        },
        {
          title: "Pressure",
          chapters: BEATS.slice(4, 9).map((beat) =>
            arcChapter(beat, context, perChapter, guidance),
          ),
        },
        {
          title: "Truth",
          chapters: BEATS.slice(9).map((beat) => arcChapter(beat, context, perChapter, guidance)),
        },
      ],
    };
  },
};

function arcChapter(beat: string, context: string, targetWords: number, guidance: string) {
  return chapter(
    beat,
    `Story overview: Use this chapter to make the ${beat} stage visible through an outer plot event and a specific inner shift. Show what should change in the protagonist's belief, desire, or choice by chapter end. Use the book premise as source material: ${context}`,
    targetWords,
    [
      {
        kind: "outer-plot",
        prompt: `Draft the external event that forces the ${beat} moment.${guidance}`,
        share: 0.45,
        beat,
      },
      {
        kind: "inner-arc",
        prompt: `Reveal how the protagonist's lie, want, need, or truth changes in this chapter.${guidance}`,
        share: 0.4,
        beat: "Inner arc",
      },
      {
        kind: "choice",
        prompt: `End on a choice, denial, or acceptance that advances the arc.${guidance}`,
        share: 0.15,
        beat: "Arc turn",
      },
    ],
  );
}
