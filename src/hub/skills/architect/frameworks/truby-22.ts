import { type Framework, chapter, chapterTarget, fictionGuidance, voiceDirection } from "./shared";

const BEAT_GROUPS = [
  {
    title: "Foundation",
    beats: [
      "Need and weakness",
      "Desire line",
      "Opponent pressure",
      "Plan",
      "Inciting disruption",
      "First revelation",
    ],
  },
  {
    title: "Escalation",
    beats: [
      "Drive",
      "Ally complications",
      "Apparent victory",
      "Opponent counterplan",
      "Midpoint revelation",
      "Moral pressure",
      "Bad turn",
      "New desire",
    ],
  },
  {
    title: "Reckoning",
    beats: [
      "Gate and gauntlet",
      "Visit to death",
      "Battle choice",
      "Self-revelation",
      "Moral decision",
      "Final confrontation",
      "New equilibrium",
      "Afterimage",
    ],
  },
] as const;

export const truby22Framework: Framework = {
  id: "truby-22",
  label: "Truby-style 22 Beats",
  type: "fiction",
  questions: [
    "What does the protagonist want on the surface?",
    "What deeper need or weakness must the plot expose?",
    "Who is the opponent and why are they morally persuasive?",
    "What final choice proves the protagonist has changed?",
  ],
  build({ title, genre, targetWordCount, questionnaire, voiceSummary, characterArcs, scenePlan }) {
    const beatCount = BEAT_GROUPS.reduce((total, group) => total + group.beats.length, 0);
    const perChapter = chapterTarget(targetWordCount, beatCount);
    const context = questionnaire || `A ${genre || "fiction"} story titled ${title}.`;
    const guidance = `${voiceDirection(voiceSummary)}${fictionGuidance({ characterArcs, scenePlan })}`;
    return {
      framework: "truby-22",
      acts: BEAT_GROUPS.map((group) => ({
        title: group.title,
        chapters: group.beats.map((beat) =>
          chapter(
            beat,
            `Story overview: Use this chapter to advance the ${beat} beat as a cause-and-effect story turn. Define what should change in the plan, opposition, moral pressure, or self-understanding by the end. Use the book premise as source material: ${context}`,
            perChapter,
            [
              {
                kind: "scene",
                prompt: `Write the visible story event for the ${beat} beat.${guidance}`,
                share: 0.55,
                beat,
              },
              {
                kind: "desire-shift",
                prompt: `Show how this beat changes the protagonist's desire, plan, or moral pressure.${guidance}`,
                share: 0.3,
                beat: "Desire and moral shift",
              },
              {
                kind: "turn",
                prompt: `Close with a revelation or decision that makes the next beat necessary.${guidance}`,
                share: 0.15,
                beat: "Revelation",
              },
            ],
          ),
        ),
      })),
    };
  },
};
