import { type Framework, chapter, chapterTarget, fictionGuidance, voiceDirection } from "./shared";

export const heroJourneyFramework: Framework = {
  id: "hero-journey",
  label: "Hero's Journey",
  type: "fiction",
  questions: [
    "Who is the protagonist and what do they want?",
    "What wound or false belief keeps them stuck?",
    "What forces them out of the ordinary world?",
    "What choice proves they have changed?",
  ],
  build({ title, genre, targetWordCount, questionnaire, voiceSummary, characterArcs, scenePlan }) {
    const perChapter = chapterTarget(targetWordCount, 12);
    const context = questionnaire || `A ${genre || "fiction"} story titled ${title}.`;
    const guidance = `${voiceDirection(voiceSummary)}${fictionGuidance({ characterArcs, scenePlan })}`;
    const beats = [
      "Ordinary World",
      "Call to Adventure",
      "Refusal",
      "Mentor",
      "Threshold",
      "Tests",
      "Approach",
      "Ordeal",
      "Reward",
      "Road Back",
      "Resurrection",
      "Return",
    ];
    return {
      framework: "hero-journey",
      acts: [
        {
          title: "Departure",
          chapters: beats
            .slice(0, 4)
            .map((beat) => heroChapter(beat, context, perChapter, guidance)),
        },
        {
          title: "Initiation",
          chapters: beats
            .slice(4, 9)
            .map((beat) => heroChapter(beat, context, perChapter, guidance)),
        },
        {
          title: "Return",
          chapters: beats.slice(9).map((beat) => heroChapter(beat, context, perChapter, guidance)),
        },
      ],
    };
  },
};

function heroChapter(beat: string, context: string, targetWords: number, guidance: string) {
  return chapter(beat, heroOverview(beat, context), targetWords, [
    {
      kind: "scene",
      prompt: `Draft a scene that expresses the ${beat} beat.${guidance}`,
      share: 0.7,
      beat,
    },
    {
      kind: "turn",
      prompt: `End with a consequential turn that changes the protagonist's options.${guidance}`,
      share: 0.3,
      beat: "Chapter turn",
    },
  ]);
}

function heroOverview(beat: string, context: string) {
  const overview: Record<string, string> = {
    "Ordinary World":
      "Establish the protagonist's normal life, central lack, and the pressure that makes change necessary.",
    "Call to Adventure":
      "Introduce the opportunity, threat, or summons that disrupts the old pattern and points toward the main story problem.",
    Refusal:
      "Show why the protagonist resists the call, what they fear losing, and why avoidance cannot hold.",
    Mentor:
      "Bring in guidance, leverage, warning, or a relationship test that reframes the journey ahead.",
    Threshold:
      "Force the protagonist across a point of no return where the old life can no longer solve the problem.",
    Tests:
      "Use escalating trials to teach the rules of the new world and expose weaknesses in the protagonist's plan.",
    Approach:
      "Narrow the goal, raise the stakes, and position the protagonist near the central ordeal.",
    Ordeal:
      "Put the protagonist through the deepest confrontation so the story's cost becomes unavoidable.",
    Reward:
      "Let the protagonist gain knowledge, power, evidence, or connection while revealing what it will cost to keep it.",
    "Road Back":
      "Turn the victory into a new danger that forces the protagonist back toward the final conflict.",
    Resurrection:
      "Stage the final transformation test where the protagonist must act from the changed self.",
    Return:
      "Show the changed world, the earned consequence of the journey, and what the protagonist now brings back.",
  };
  return `Story overview: ${overview[beat] ?? `Shape the ${beat} beat into a clear turn in the story.`} Use the book premise as source material: ${context}`;
}
