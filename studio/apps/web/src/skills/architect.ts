import type { Env } from "../env";
import { gateway } from "../lib/gateway";
import { frameworkFor } from "./architect/frameworks";
import type {
  ChapterPlanGuidance,
  CharacterArcGuidance,
  FrameworkChapter,
  FrameworkOutline,
  ProjectKind,
  ScenePlanGuidance,
} from "./architect/frameworks/shared";

export type GenerateOutlineInput = {
  title: string;
  type: ProjectKind;
  genre?: string | null;
  targetWordCount: number;
  framework?: string;
  questionnaire: string;
  voiceProfile?: unknown;
  characterArcs?: CharacterArcGuidance[];
  scenePlan?: ScenePlanGuidance;
  chapterPlan?: ChapterPlanGuidance[];
};

export function generateOutline(input: GenerateOutlineInput): FrameworkOutline {
  const framework = frameworkFor(input.framework, input.type);
  const voiceSummary =
    input.voiceProfile &&
    typeof input.voiceProfile === "object" &&
    "summary" in input.voiceProfile &&
    typeof input.voiceProfile.summary === "string"
      ? input.voiceProfile.summary
      : undefined;

  const outline = framework.build({
    title: input.title,
    genre: input.genre,
    targetWordCount: input.targetWordCount,
    questionnaire: input.questionnaire,
    voiceSummary,
    characterArcs: input.characterArcs,
    scenePlan: input.scenePlan,
    chapterPlan: input.chapterPlan,
  });
  return applyChapterPlan(outline, input.chapterPlan);
}

export async function generateOutlineWithAi(
  env: Pick<Env, "AI_GATEWAY_BASE_URL" | "AI_GATEWAY_TOKEN">,
  input: GenerateOutlineInput,
): Promise<FrameworkOutline> {
  const outline = generateOutline(input);
  const storyOutline = applyStoryBreakdown(outline, input);
  if (!env.AI_GATEWAY_BASE_URL || !env.AI_GATEWAY_TOKEN) return storyOutline;

  try {
    const result = await gateway.chatCompletion(env, {
      route: "dynamic/text_gen",
      temperature: 0.35,
      maxTokens: 3200,
      messages: [
        {
          role: "system",
          content:
            "You are a book architect. Return strict JSON only, no markdown. Break the supplied premise into chapter-level story events that fit the selected framework beats. Do not draft prose. Each chapter summary must say what should happen in that chapter, not what is happening in the prose.",
        },
        {
          role: "user",
          content: JSON.stringify({
            book: {
              title: input.title,
              type: input.type,
              genre: input.genre,
              premise: input.questionnaire,
            },
            framework: outline.framework,
            character_arcs: input.characterArcs ?? [],
            scene_plan: input.scenePlan ?? null,
            required_shape: {
              chapters: flattenChapters(outline).map((item) => ({
                ordinal: item.ordinal,
                title: item.chapter.title,
                current_summary: item.chapter.summary,
                section_beats: item.chapter.sections.map((section) => section.beat),
              })),
            },
            output_schema: {
              chapters: [
                {
                  ordinal: 1,
                  title: "Optional improved chapter title",
                  summary:
                    "Beat purpose: one sentence. What might happen: concrete story event, pressure, decision, reversal, and chapter-end change.",
                  section_prompts: [
                    {
                      kind: "same kind as input section",
                      prompt:
                        "Optional concrete section direction tied to the chapter event and beat.",
                    },
                  ],
                },
              ],
            },
          }),
        },
      ],
    });
    return applyAiBreakdown(storyOutline, parseAiBreakdown(result.text));
  } catch (error) {
    console.warn("outline AI breakdown fell back to deterministic story plan", error);
    return storyOutline;
  }
}

function applyChapterPlan(
  outline: FrameworkOutline,
  chapterPlan: ChapterPlanGuidance[] | undefined,
): FrameworkOutline {
  const plansByOrdinal = new Map(
    (chapterPlan ?? [])
      .filter((plan) => plan.event.trim())
      .map((plan) => [plan.ordinal, plan] as const),
  );
  if (!plansByOrdinal.size) return outline;

  let ordinal = 1;
  return {
    ...outline,
    acts: outline.acts.map((act) => ({
      ...act,
      chapters: act.chapters.map((chapter) => {
        const plan = plansByOrdinal.get(ordinal);
        ordinal += 1;
        return plan ? applyPlanToChapter(chapter, plan) : chapter;
      }),
    })),
  };
}

function applyPlanToChapter(
  chapter: FrameworkChapter,
  plan: ChapterPlanGuidance,
): FrameworkChapter {
  const plannedContext = chapterPlanContext(plan);
  return {
    ...chapter,
    title: plan.title?.trim() || chapter.title,
    summary: `${chapter.summary} Chapter decision: ${plannedContext}`,
    sections: chapter.sections.map((section) => ({
      ...section,
      prompt: `${section.prompt} Chapter decision: ${plannedContext}`,
    })),
  };
}

function chapterPlanContext(plan: ChapterPlanGuidance) {
  return [
    `event: ${plan.event.trim()}`,
    plan.purpose?.trim() ? `purpose: ${plan.purpose.trim()}` : "",
    plan.pov?.trim() ? `POV: ${plan.pov.trim()}` : "",
    plan.characters?.trim() ? `characters: ${plan.characters.trim()}` : "",
  ]
    .filter(Boolean)
    .join("; ");
}

type FlatChapter = {
  ordinal: number;
  chapter: FrameworkChapter;
};

type AiBreakdown = {
  chapters?: {
    ordinal?: number;
    title?: string;
    summary?: string;
    section_prompts?: {
      kind?: string;
      prompt?: string;
    }[];
  }[];
};

function flattenChapters(outline: FrameworkOutline): FlatChapter[] {
  let ordinal = 1;
  return outline.acts.flatMap((act) =>
    act.chapters.map((chapter) => ({
      ordinal: ordinal++,
      chapter,
    })),
  );
}

function parseAiBreakdown(text: string): AiBreakdown {
  const trimmed = text.trim();
  if (!trimmed) return {};
  try {
    return JSON.parse(trimmed) as AiBreakdown;
  } catch {
    const match = trimmed.match(/\{[\s\S]*\}/);
    return match ? (JSON.parse(match[0]) as AiBreakdown) : {};
  }
}

function applyAiBreakdown(outline: FrameworkOutline, breakdown: AiBreakdown): FrameworkOutline {
  const byOrdinal = new Map(
    (breakdown.chapters ?? [])
      .filter((chapter) => chapter.ordinal && chapter.summary?.trim())
      .map((chapter) => [chapter.ordinal as number, chapter] as const),
  );
  if (!byOrdinal.size) return outline;

  let ordinal = 1;
  return {
    ...outline,
    acts: outline.acts.map((act) => ({
      ...act,
      chapters: act.chapters.map((chapter) => {
        const aiChapter = byOrdinal.get(ordinal);
        ordinal += 1;
        if (!aiChapter?.summary?.trim()) return chapter;
        const sectionPrompts = new Map(
          (aiChapter.section_prompts ?? [])
            .filter((section) => section.kind?.trim() && section.prompt?.trim())
            .map((section) => [section.kind as string, section.prompt as string] as const),
        );
        return {
          ...chapter,
          title: aiChapter.title?.trim() || chapter.title,
          summary: normalizeSummary(aiChapter.summary),
          sections: chapter.sections.map((section) => ({
            ...section,
            prompt: sectionPrompts.get(section.kind) ?? section.prompt,
          })),
        };
      }),
    })),
  };
}

function applyStoryBreakdown(
  outline: FrameworkOutline,
  input: GenerateOutlineInput,
): FrameworkOutline {
  const premise = storyPremise(input);
  const chapters = flattenChapters(outline);
  const total = chapters.length;
  const plansByOrdinal = new Map((input.chapterPlan ?? []).map((plan) => [plan.ordinal, plan]));
  let ordinal = 1;
  return {
    ...outline,
    acts: outline.acts.map((act) => ({
      ...act,
      chapters: act.chapters.map((chapter) => {
        const currentOrdinal = ordinal++;
        return rewriteChapterForStory(chapter, {
          ordinal: currentOrdinal,
          total,
          premise,
          input,
          plan: plansByOrdinal.get(currentOrdinal),
        });
      }),
    })),
  };
}

function storyPremise(input: GenerateOutlineInput) {
  const context =
    input.questionnaire.trim() || `${input.genre || input.type} book titled ${input.title}`;
  const sentences = context
    .replace(/\s+/g, " ")
    .split(/(?<=[.!?])\s+/)
    .map((sentence) => sentence.trim())
    .filter(Boolean);
  return {
    context,
    setup: sentences[0] ?? context,
    pressure: sentences[0] ?? context,
    complication: sentences[1] ?? sentences[0] ?? context,
    ending: sentences.at(-1) ?? context,
    names: extractNames(context),
  };
}

function rewriteChapterForStory(
  chapter: FrameworkChapter,
  options: {
    ordinal: number;
    total: number;
    premise: ReturnType<typeof storyPremise>;
    input: GenerateOutlineInput;
    plan?: ChapterPlanGuidance;
  },
): FrameworkChapter {
  const beatPurpose = extractBeatPurpose(chapter.summary, chapter.title);
  const event = options.plan?.event.trim()
    ? `Follow the chapter decision: ${chapterPlanContext(options.plan)}`
    : concreteStoryEvent(chapter.title, options);
  return {
    ...chapter,
    summary: normalizeSummary(`Beat purpose: ${beatPurpose} What might happen: ${event}`),
    sections: chapter.sections.map((section) => ({
      ...section,
      prompt: `${section.prompt} Use this concrete chapter event: ${event}`,
    })),
  };
}

function extractBeatPurpose(summary: string, title: string) {
  const withoutPrefix = summary
    .replace(/^Story overview:\s*/i, "")
    .replace(/^Chapter overview:\s*/i, "")
    .replace(/\s*Use the book premise as source material:[\s\S]*$/i, "")
    .trim();
  return withoutPrefix || `Make the ${title} beat create a visible change in the book.`;
}

function concreteStoryEvent(
  beat: string,
  options: {
    ordinal: number;
    total: number;
    premise: ReturnType<typeof storyPremise>;
    input: GenerateOutlineInput;
  },
) {
  const { ordinal, total, premise, input } = options;
  const cast = characterNames(input, premise.names);
  const lead = cast[0] ?? "the protagonist";
  const second = cast[1] ?? "an important relationship";
  const progress = ordinal / Math.max(total, 1);
  const lowerBeat = beat.toLowerCase();
  const framework = input.framework ?? "";

  if (input.type === "nonfiction") {
    return nonfictionEvent(beat, premise, ordinal, total);
  }

  if (framework === "thriller" || lowerBeat.includes("threat") || lowerBeat.includes("trap")) {
    return thrillerEvent(beat, premise, lead, second, progress);
  }
  if (framework === "sci-fi" || lowerBeat.includes("world") || lowerBeat.includes("technology")) {
    return sciFiEvent(beat, premise, lead, second, progress);
  }
  if (framework === "truby-22" || lowerBeat.includes("moral") || lowerBeat.includes("desire")) {
    return trubyEvent(beat, premise, lead, second, progress);
  }
  return heroEvent(beat, premise, lead, second, progress);
}

function heroEvent(
  beat: string,
  premise: ReturnType<typeof storyPremise>,
  lead: string,
  second: string,
  progress: number,
) {
  const templates: Record<string, string> = {
    "Ordinary World": `${lead} is shown inside the life created by the premise: ${premise.setup} The chapter should reveal what feels normal, what already hurts, and what secret pressure cannot stay hidden.`,
    "Call to Adventure": `A concrete interruption turns ${premise.pressure} into an immediate story problem, forcing ${lead} to notice a threat or opportunity they can no longer treat as background.`,
    Refusal: `${lead} tries to preserve the old arrangement by minimizing the danger, hiding the truth, or protecting ${second}, but the refusal creates a sharper consequence.`,
    Mentor: `A guide, warning, clue, or reluctant ally gives ${lead} a new way to read ${premise.complication}, while also making the cost of action clearer.`,
    Threshold: `${lead} makes a choice that commits them to the central conflict; after this chapter, returning to the earlier life would mean losing something specific.`,
    Tests: `${lead} faces a series of smaller conflicts that reveal the rules of the new world and expose the weakness that the ending must transform.`,
    Approach: `${lead} narrows the goal and prepares for the central confrontation, but the plan depends on an assumption the story is about to challenge.`,
    Ordeal: `${lead} is forced into the deepest confrontation with the premise, paying a personal price that changes what victory can mean.`,
    Reward: `${lead} gains evidence, connection, leverage, or self-knowledge, but the gain exposes a new obligation that cannot be ignored.`,
    "Road Back": `The apparent gain triggers a return pressure: ${lead} must carry the new truth back into the world or relationship where the original wound began.`,
    Resurrection: `${lead} faces the final test and must act from the changed self rather than the old fear, proving the arc through a visible irreversible choice.`,
    Return: `The chapter shows the changed world after the choice, including what ${lead} can now offer, confess, repair, or release because of the journey.`,
  };
  return templates[beat] ?? phaseEvent(beat, premise, lead, progress);
}

function thrillerEvent(
  beat: string,
  premise: ReturnType<typeof storyPremise>,
  lead: string,
  second: string,
  progress: number,
) {
  if (progress < 0.35) {
    return `${lead} encounters a clue, threat, or suspicious inconsistency inside ${premise.setup}; the chapter should end by making inaction more dangerous than investigation.`;
  }
  if (progress < 0.7) {
    return `The investigation around ${premise.pressure} produces a reversal: ${lead}'s current theory breaks, ${second} becomes harder to trust, and the antagonist's reach feels larger.`;
  }
  return `${lead} converts the darkest discovery into a countermove, forcing the hidden conflict into the open and setting up a confrontation with a deadline, betrayal, or confession.`;
}

function sciFiEvent(
  beat: string,
  premise: ReturnType<typeof storyPremise>,
  lead: string,
  second: string,
  progress: number,
) {
  if (progress < 0.35) {
    return `${lead} discovers a visible rule or anomaly from the speculative premise: ${premise.setup} The scene should make the world feel concrete while tying the idea to a personal need.`;
  }
  if (progress < 0.7) {
    return `The speculative system pushes back: ${premise.pressure} becomes a social, technical, or ethical cost that changes what ${lead} and ${second} can safely do.`;
  }
  return `${lead} must redesign their relationship to the technology, society, or future implied by ${premise.complication}, ending with a choice that creates a changed world.`;
}

function trubyEvent(
  beat: string,
  premise: ReturnType<typeof storyPremise>,
  lead: string,
  second: string,
  progress: number,
) {
  if (progress < 0.35) {
    return `${lead}'s desire becomes concrete through ${premise.setup}, but the chapter should reveal the deeper weakness or moral blind spot beneath that desire.`;
  }
  if (progress < 0.7) {
    return `${lead}'s plan collides with opposition around ${premise.pressure}; a revelation changes the desire line and adds moral pressure involving ${second}.`;
  }
  return `${lead} must choose between the old desire and the deeper need exposed by ${premise.complication}, creating a final moral action rather than a simple plot win.`;
}

function phaseEvent(
  beat: string,
  premise: ReturnType<typeof storyPremise>,
  lead: string,
  progress: number,
) {
  if (progress < 0.35) {
    return `${lead} enters the conflict through a concrete event drawn from the premise: ${premise.setup} The chapter should establish stakes and force a first adjustment.`;
  }
  if (progress < 0.7) {
    return `${lead}'s plan runs into a consequential complication from ${premise.pressure}, forcing a new decision and making the next chapter necessary.`;
  }
  return `${lead} acts on the hard truth behind ${premise.complication}, moving the story toward an irreversible ending rather than another setup beat.`;
}

function nonfictionEvent(
  beat: string,
  premise: ReturnType<typeof storyPremise>,
  ordinal: number,
  total: number,
) {
  const progress = ordinal / Math.max(total, 1);
  if (progress < 0.35) {
    return `Use ${premise.setup} to diagnose the reader's current problem in this chapter, naming the costly pattern and the specific belief that needs to change.`;
  }
  if (progress < 0.7) {
    return `Develop ${premise.pressure} into a concrete teaching move for "${beat}", using an example, model, or case that changes the reader's operating assumptions.`;
  }
  return `Turn ${premise.complication} into an application chapter: the reader should make a decision, run a practice, or adopt a system that carries the book's promise forward.`;
}

function characterNames(input: GenerateOutlineInput, extracted: string[]) {
  const fromGuidance = (input.characterArcs ?? [])
    .map((character) => character.name.trim())
    .filter(Boolean);
  return [...new Set([...fromGuidance, ...extracted])].slice(0, 4);
}

function extractNames(value: string) {
  const blocked = new Set([
    "A",
    "An",
    "The",
    "When",
    "This",
    "There",
    "Meanwhile",
    "Chapter",
    "Story",
    "Use",
  ]);
  return [...value.matchAll(/\b[A-Z][a-z]+(?:\s+[A-Z][a-z]+)?\b/g)]
    .map(([name]) => name.trim())
    .filter((name) => !blocked.has(name.split(/\s+/)[0]))
    .slice(0, 6);
}

function normalizeSummary(value: string) {
  return value.replace(/\s+/g, " ").trim();
}
