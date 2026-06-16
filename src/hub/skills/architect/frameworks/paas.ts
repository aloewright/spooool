import { type Framework, chapterTarget } from "./shared";

export const paasFramework: Framework = {
  id: "paas",
  label: "Problem -> Agitate -> Solve",
  type: "nonfiction",
  questions: [
    "What painful problem does the reader want solved?",
    "What has the reader already tried?",
    "What promise can this book credibly make?",
    "What proof, stories, or examples can support the method?",
  ],
  build({ title, genre, targetWordCount, questionnaire, voiceSummary }) {
    const perChapter = chapterTarget(targetWordCount, 9);
    const context = questionnaire || `A ${genre || "nonfiction"} book titled ${title}.`;
    const voice = voiceSummary ? ` Use this voice direction: ${voiceSummary}` : "";
    return {
      framework: "paas",
      acts: [
        {
          title: "Problem",
          chapters: [
            chapter("The Cost of Staying Stuck", context, perChapter, voice),
            chapter("Why Common Advice Fails", context, perChapter, voice),
            chapter("The Real Constraint", context, perChapter, voice),
          ],
        },
        {
          title: "Agitate",
          chapters: [
            chapter("The Hidden Pattern", context, perChapter, voice),
            chapter("The Turning Point", context, perChapter, voice),
            chapter("A Better Operating Model", context, perChapter, voice),
          ],
        },
        {
          title: "Solve",
          chapters: [
            chapter("The First Practical Shift", context, perChapter, voice),
            chapter("Building the System", context, perChapter, voice),
            chapter("What Changes Afterward", context, perChapter, voice),
          ],
        },
      ],
    };
  },
};

function chapter(title: string, context: string, targetWords: number, voice: string) {
  return {
    title,
    summary: `Chapter overview: Use this chapter to move the reader through "${title}" as a clear step in the problem, agitation, or solution arc. Define what should shift in the reader's understanding, urgency, or next action by chapter end. Use the book premise as source material: ${context}`,
    target_words: targetWords,
    sections: [
      {
        kind: "opening",
        prompt: `Open with a concrete reader-facing scenario.${voice}`,
        target_words: Math.round(targetWords * 0.25),
        beat: "Hook",
      },
      {
        kind: "argument",
        prompt: `Develop the central claim with examples from the questionnaire.${voice}`,
        target_words: Math.round(targetWords * 0.5),
        beat: "Core teaching",
      },
      {
        kind: "practice",
        prompt: `Close with an action step or diagnostic question.${voice}`,
        target_words: Math.round(targetWords * 0.25),
        beat: "Application",
      },
    ],
  };
}
