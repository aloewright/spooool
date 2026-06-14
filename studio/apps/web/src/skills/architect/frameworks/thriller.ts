import { type Framework, chapter, chapterTarget, fictionGuidance, voiceDirection } from "./shared";

const BEATS = [
  "Cold open threat",
  "Everyday vulnerability",
  "Inciting crime",
  "Investigation begins",
  "First false lead",
  "Personal stakes surface",
  "Antagonist escalation",
  "Midpoint reversal",
  "Conspiracy widens",
  "Trap closes",
  "Allies fracture",
  "Darkest discovery",
  "Countermove",
  "Final confrontation",
  "Aftershock",
] as const;

export const thrillerFramework: Framework = {
  id: "thriller",
  label: "Thriller Escalation",
  type: "fiction",
  questions: [
    "What danger opens the book before anyone fully understands it?",
    "What personal stakes make retreat impossible?",
    "What does the antagonist know that the protagonist does not?",
    "What reversal changes the meaning of the investigation?",
  ],
  build({ title, genre, targetWordCount, questionnaire, voiceSummary, characterArcs, scenePlan }) {
    const perChapter = chapterTarget(targetWordCount, BEATS.length);
    const context = questionnaire || `A ${genre || "thriller"} titled ${title}.`;
    const guidance = `${voiceDirection(voiceSummary)}${fictionGuidance({ characterArcs, scenePlan })}`;
    return {
      framework: "thriller",
      acts: [
        {
          title: "Threat",
          chapters: BEATS.slice(0, 5).map((beat) =>
            thrillerChapter(beat, context, perChapter, guidance),
          ),
        },
        {
          title: "Reversal",
          chapters: BEATS.slice(5, 11).map((beat) =>
            thrillerChapter(beat, context, perChapter, guidance),
          ),
        },
        {
          title: "Confrontation",
          chapters: BEATS.slice(11).map((beat) =>
            thrillerChapter(beat, context, perChapter, guidance),
          ),
        },
      ],
    };
  },
};

function thrillerChapter(beat: string, context: string, targetWords: number, guidance: string) {
  return chapter(
    beat,
    `Story overview: Use this chapter to deliver the ${beat} function by changing what the protagonist knows, wants, fears, or can safely do next. Escalate suspense with a concrete clue, threat, reversal, or deadline. Use the book premise as source material: ${context}`,
    targetWords,
    [
      {
        kind: "threat",
        prompt: `Open with a concrete threat, clue, or pressure point for ${beat}.${guidance}`,
        share: 0.35,
        beat,
      },
      {
        kind: "investigation",
        prompt: `Advance the investigation while adding one complication or false certainty.${guidance}`,
        share: 0.45,
        beat: "Investigation pressure",
      },
      {
        kind: "cliffhanger",
        prompt: `End with a reveal, deadline, betrayal, or danger that forces the next chapter.${guidance}`,
        share: 0.2,
        beat: "Suspense turn",
      },
    ],
  );
}
