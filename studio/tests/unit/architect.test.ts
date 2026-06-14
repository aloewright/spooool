import { describe, expect, it } from "vitest";
import { generateOutline, generateOutlineWithAi } from "../../apps/web/src/skills/architect";

describe("architect outline generation", () => {
  it("builds nonfiction chapter structure", () => {
    const outline = generateOutline({
      title: "Better Systems",
      type: "nonfiction",
      targetWordCount: 45_000,
      questionnaire: "Readers are stuck in reactive work. Promise a calmer operating model.",
    });

    expect(outline.framework).toBe("paas");
    expect(outline.acts).toHaveLength(3);
    expect(outline.acts.flatMap((act) => act.chapters)).toHaveLength(9);
  });

  it("builds fiction chapter structure", () => {
    const outline = generateOutline({
      title: "The Last Harbor",
      type: "fiction",
      targetWordCount: 72_000,
      questionnaire: "A captain wants to save their town but must betray an old oath.",
    });

    expect(outline.framework).toBe("hero-journey");
    expect(outline.acts.flatMap((act) => act.chapters)).toHaveLength(12);
    expect(outline.acts[1].chapters[0].summary).toContain("Story overview");
    expect(outline.acts[1].chapters[0].summary).toContain("point of no return");
  });

  it("builds Truby-style 22 beat fiction structure", () => {
    const outline = generateOutline({
      title: "The Last Harbor",
      type: "fiction",
      targetWordCount: 88_000,
      framework: "truby-22",
      questionnaire: "A captain wants to save their town but must betray an old oath.",
    });

    expect(outline.framework).toBe("truby-22");
    expect(outline.acts.flatMap((act) => act.chapters)).toHaveLength(22);
    expect(outline.acts[0].chapters[0].title).toBe("Need and weakness");
  });

  it("builds genre-specific fiction structures", () => {
    const thriller = generateOutline({
      title: "Dead Switch",
      type: "fiction",
      targetWordCount: 75_000,
      framework: "thriller",
      questionnaire: "A journalist finds a dead man's warning and becomes the next target.",
    });
    const sciFi = generateOutline({
      title: "Signal Garden",
      type: "fiction",
      targetWordCount: 84_000,
      framework: "sci-fi",
      questionnaire: "A botanist discovers plants that store memories from future colonists.",
    });

    expect(thriller.framework).toBe("thriller");
    expect(thriller.acts.flatMap((act) => act.chapters)).toHaveLength(15);
    expect(sciFi.framework).toBe("sci-fi");
    expect(sciFi.acts.flatMap((act) => act.chapters)).toHaveLength(14);
  });

  it("builds reader transformation nonfiction structure", () => {
    const outline = generateOutline({
      title: "Better Systems",
      type: "nonfiction",
      targetWordCount: 48_000,
      framework: "reader-transformation",
      questionnaire: "Readers need to move from reactive work to calm weekly planning.",
    });

    expect(outline.framework).toBe("reader-transformation");
    expect(outline.acts.flatMap((act) => act.chapters)).toHaveLength(12);
    expect(outline.acts[2].title).toBe("Apply");
  });

  it("threads fiction character arc and scene guidance into prompts", () => {
    const outline = generateOutline({
      title: "Signal Garden",
      type: "fiction",
      targetWordCount: 84_000,
      framework: "sci-fi",
      questionnaire: "A botanist discovers plants that store memories from future colonists.",
      characterArcs: [
        {
          name: "Mara",
          arc: "Positive Change",
          position: "refusing the truth that memory can be communal",
          sceneRole: "protagonist under scientific and family pressure",
        },
        {
          name: "Ivo",
          arc: "Flat",
          position: "already believes the future colony must be protected",
          sceneRole: "ally who pressures Mara to act",
        },
      ],
      scenePlan: {
        defaultCast: "Use Mara and Ivo together in discovery scenes.",
        miniStructure: "Setup the discovery, turn on a memory reveal, close with a cost.",
      },
    });

    const firstPrompt = outline.acts[0].chapters[0].sections[0].prompt;
    expect(firstPrompt).toContain("Character arc map");
    expect(firstPrompt).toContain("Mara");
    expect(firstPrompt).toContain("Positive Change");
    expect(firstPrompt).toContain("Use Mara and Ivo together");
    expect(firstPrompt).toContain("Setup the discovery");
  });

  it("applies chapter decisions before summaries and prompts are created", () => {
    const outline = generateOutline({
      title: "Signal Garden",
      type: "fiction",
      targetWordCount: 84_000,
      framework: "sci-fi",
      questionnaire: "A botanist discovers plants that store memories from future colonists.",
      chapterPlan: [
        {
          ordinal: 1,
          title: "The Memory Orchard",
          event: "Mara finds a greenhouse tree replaying a future evacuation.",
          purpose: "Prove the premise with a visible event.",
          pov: "Mara",
          characters: "Mara, Ivo",
        },
      ],
    });

    const firstChapter = outline.acts[0].chapters[0];
    expect(firstChapter.title).toBe("The Memory Orchard");
    expect(firstChapter.summary).toContain("future evacuation");
    expect(firstChapter.summary).toContain("Prove the premise");
    expect(firstChapter.sections[0].prompt).toContain("Mara, Ivo");
  });

  it("does not apply a framework from the wrong project type", () => {
    const outline = generateOutline({
      title: "Better Systems",
      type: "nonfiction",
      targetWordCount: 45_000,
      framework: "thriller",
      questionnaire: "Readers are stuck in reactive work.",
    });

    expect(outline.framework).toBe("paas");
  });

  it("enriches framework beats into concrete story-specific chapter events", async () => {
    const outline = await generateOutlineWithAi(
      { AI_GATEWAY_BASE_URL: "", AI_GATEWAY_TOKEN: "" },
      {
        title: "Dash Return",
        type: "fiction",
        targetWordCount: 72_000,
        framework: "hero-journey",
        questionnaire:
          "When a shocking secret is about to be exposed, rapper Dash must confront his past and confess to his family before it's too late. Fifteen years prior Dash faked his own death to escape fame and expectations. Ji-hoon is testing facial recognition software and finds a photo of Dash marked as deceased.",
      },
    );

    const [ordinary, call] = outline.acts[0].chapters;
    expect(ordinary.summary).toContain("Beat purpose:");
    expect(ordinary.summary).toContain("What might happen:");
    expect(ordinary.summary).toContain("Dash");
    expect(ordinary.summary).not.toContain("Use the book premise as source material");
    expect(call.summary).toContain("immediate story problem");
    expect(call.summary).toContain("shocking secret");
  });
});
