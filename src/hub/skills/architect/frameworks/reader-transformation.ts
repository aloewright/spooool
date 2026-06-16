import { type Framework, chapter, chapterTarget, voiceDirection } from "./shared";

const BEATS = [
  "Reader promise",
  "Current-state diagnosis",
  "Cost of the old model",
  "New lens",
  "Core principle one",
  "Core principle two",
  "Core principle three",
  "Implementation plan",
  "Common failure modes",
  "Case study",
  "Practice system",
  "Future-state handoff",
] as const;

export const readerTransformationFramework: Framework = {
  id: "reader-transformation",
  label: "Reader Transformation",
  type: "nonfiction",
  questions: [
    "What is the reader's current state?",
    "What measurable or felt transformation should the book deliver?",
    "What method, proof, or case studies support the promise?",
    "What should the reader do differently after each chapter?",
  ],
  build({ title, genre, targetWordCount, questionnaire, voiceSummary }) {
    const perChapter = chapterTarget(targetWordCount, BEATS.length);
    const context = questionnaire || `A ${genre || "nonfiction"} book titled ${title}.`;
    const voice = voiceDirection(voiceSummary);
    return {
      framework: "reader-transformation",
      acts: [
        {
          title: "Diagnose",
          chapters: BEATS.slice(0, 4).map((beat) =>
            nonfictionChapter(beat, context, perChapter, voice),
          ),
        },
        {
          title: "Teach",
          chapters: BEATS.slice(4, 9).map((beat) =>
            nonfictionChapter(beat, context, perChapter, voice),
          ),
        },
        {
          title: "Apply",
          chapters: BEATS.slice(9).map((beat) =>
            nonfictionChapter(beat, context, perChapter, voice),
          ),
        },
      ],
    };
  },
};

function nonfictionChapter(beat: string, context: string, targetWords: number, voice: string) {
  return chapter(
    beat,
    `Chapter overview: Use this chapter to move the reader through the ${beat} step of the transformation. Define what should become clearer, easier, or more actionable for the reader by chapter end. Use the book premise as source material: ${context}`,
    targetWords,
    [
      {
        kind: "promise",
        prompt: `Open with the reader-facing problem or promise for ${beat}.${voice}`,
        share: 0.25,
        beat,
      },
      {
        kind: "teaching",
        prompt: `Teach the central idea with a concrete example, story, or model.${voice}`,
        share: 0.5,
        beat: "Teaching",
      },
      {
        kind: "application",
        prompt: `Close with a practical exercise, checklist, or next decision.${voice}`,
        share: 0.25,
        beat: "Application",
      },
    ],
  );
}
