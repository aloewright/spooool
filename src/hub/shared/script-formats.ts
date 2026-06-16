// Script format catalog shared by the worker (validation, planning thresholds)
// and the client (compose wizard, structure picker). Each format curates its
// own structure templates and scene-planning minimums.

import { distributeBeats } from "./beat-plan";
import { FICTION_FRAMEWORK_STRUCTURES } from "./blog-formats";

export type ScriptFormatId = "feature" | "tv-episode" | "short-film" | "stage-play";

export type ScriptStructureBeat = {
  title: string;
  summary: string;
};

export type ScriptStructure = {
  id: string;
  label: string;
  description: string;
  /**
   * Narrative beats for the structure. Planning a script pre-titles the
   * scene slots with these beats — one per scene when the count allows,
   * grouped or continued otherwise. See planScenesForStructure.
   */
  beats?: ScriptStructureBeat[];
};

export type ScriptFormat = {
  id: ScriptFormatId;
  emoji: string;
  shorthand: string;
  description: string;
  structures: ScriptStructure[];
  /** Minimum scenes planned per script for a workable draft. */
  minScenes: number;
  defaultScenes: number;
  planningNote: string;
};

export const SCRIPT_FORMATS: ScriptFormat[] = [
  {
    id: "feature",
    emoji: "🎬",
    shorthand: "Feature film",
    description:
      "A feature-length screenplay — 90 to 120 pages of escalating, visual storytelling.",
    structures: [
      {
        id: "three-act",
        label: "Three-Act Structure",
        description: "The classic setup, confrontation, and resolution spine.",
        beats: threeActBeats(),
      },
      {
        id: "save-the-cat",
        label: "Save the Cat",
        description: "Blake Snyder's fifteen-beat sheet, from opening image to final image.",
        beats: saveTheCatBeats(),
      },
      {
        id: "story-circle",
        label: "Story Circle",
        description: "Dan Harmon's eight-step loop of comfort, need, descent, and return.",
        beats: storyCircleBeats(),
      },
    ],
    minScenes: 8,
    defaultScenes: 12,
    planningNote:
      "Features need room to escalate — plan at least 8 scenes so each act earns its turn. Picking a structure defaults to one scene per beat.",
  },
  {
    id: "tv-episode",
    emoji: "📺",
    shorthand: "TV episode",
    description:
      "An episode of television built around act breaks, A/B stories, and a returning world.",
    structures: [
      {
        id: "five-act",
        label: "Cold Open + Five Acts",
        description:
          "Broadcast-style act breaks, each ending on a turn that survives the commercial.",
        beats: fiveActBeats(),
      },
      {
        id: "sitcom-ab",
        label: "A/B Story Weave",
        description:
          "Two plots launched separately, escalated in parallel, and collided for the finale.",
        beats: sitcomAbBeats(),
      },
    ],
    minScenes: 5,
    defaultScenes: 7,
    planningNote:
      "Episodes live and die on act breaks — plan at least 5 scenes so every act gets its turn.",
  },
  {
    id: "short-film",
    emoji: "🎞️",
    shorthand: "Short film",
    description: "A short — one idea, one turn, executed with total economy.",
    structures: [
      {
        id: "single-turn",
        label: "Single Turn",
        description: "Setup, one irreversible turn, payoff — the minimal short.",
        beats: singleTurnBeats(),
      },
      {
        id: "mini-arc",
        label: "Mini Arc",
        description: "A compressed character arc: hook, want, obstacle, choice, aftermath.",
        beats: miniArcBeats(),
      },
    ],
    minScenes: 3,
    defaultScenes: 3,
    planningNote:
      "Shorts are about economy — plan at least 3 scenes and cut anything that doesn't turn.",
  },
  {
    id: "stage-play",
    emoji: "🎭",
    shorthand: "Stage play",
    description:
      "A play for the stage — live bodies in one room, where language carries the action.",
    structures: [
      {
        id: "two-act-stage",
        label: "Two-Act Stage",
        description:
          "An evening of theatre built to an interval question and a second-act reckoning.",
        beats: twoActStageBeats(),
      },
    ],
    minScenes: 6,
    defaultScenes: 8,
    planningNote:
      "Stage time is expensive — plan at least 6 scenes so each act builds to its curtain.",
  },
];

// Make the cross-format story frameworks (Hero's Journey, Truby 22, Character
// Arc, Thriller Escalation, Sci-Fi World + Idea) selectable in every script
// format too — shared with the book/blog flows via blog-formats.ts. The two
// structure shapes are identical ({ id, label, description, beats }).
for (const format of SCRIPT_FORMATS) {
  format.structures = [...format.structures, ...FICTION_FRAMEWORK_STRUCTURES];
}

export const SCRIPT_FORMAT_IDS = SCRIPT_FORMATS.map((f) => f.id) as [
  ScriptFormatId,
  ...ScriptFormatId[],
];

export function getScriptFormat(id: string): ScriptFormat | undefined {
  return SCRIPT_FORMATS.find((f) => f.id === id);
}

/**
 * Maps a structure's narrative beats onto `count` planned scenes. One beat per
 * scene when the count allows (extra scenes continue their beat); when there
 * are fewer scenes than beats, each scene covers a contiguous group of beats.
 * Structures without beats produce untitled slots.
 */
export function planScenesForStructure(
  structure: ScriptStructure | undefined,
  count: number,
): ScriptStructureBeat[] {
  return distributeBeats(structure?.beats ?? [], count);
}

// ---------------------------------------------------------------------------
// Screenwriting framework beats. Each summary is craft guidance for drafting
// the scene(s) that carry that beat.

function threeActBeats(): ScriptStructureBeat[] {
  return [
    {
      title: "Opening Image",
      summary:
        "Open on a single image or moment that captures the protagonist's world and flaw before anything changes. It should rhyme with the final image so the transformation is measurable.",
    },
    {
      title: "Setup",
      summary:
        "Establish the protagonist's everyday life, relationships, and what's missing. Plant the stakes and habits the rest of the film will test.",
    },
    {
      title: "Inciting Incident",
      summary:
        "Disrupt the status quo with an event the protagonist can't ignore or undo. Make it specific, visual, and aimed straight at their weakness.",
    },
    {
      title: "Debate",
      summary:
        "Let the protagonist resist the call — weigh the cost, try half-measures, ask whether change is really necessary. The audience should feel why staying put is tempting.",
    },
    {
      title: "Break into Act Two",
      summary:
        "Force a clear, active choice that pushes the protagonist into unfamiliar territory. From here the old world can no longer solve the problem.",
    },
    {
      title: "New World",
      summary:
        "Explore the rules, allies, and dangers of the new situation. Show the protagonist coping with old tools that no longer quite work.",
    },
    {
      title: "Midpoint Reversal",
      summary:
        "Hand the protagonist a false victory or a crushing defeat that changes what the story is about. The stakes shift from external to personal.",
    },
    {
      title: "Stakes Escalate",
      summary:
        "Tighten the screws: the antagonist adapts, allies waver, and time runs short. Every gain from here on costs something.",
    },
    {
      title: "All Is Lost",
      summary:
        "Strip away the protagonist's plan, allies, or self-belief in one decisive blow. Touch a whiff of death — literal, professional, or emotional.",
    },
    {
      title: "Break into Act Three",
      summary:
        "Out of the wreckage, the protagonist synthesizes a new truth and a new plan. The decision must come from who they've become, not who they were.",
    },
    {
      title: "Climax",
      summary:
        "Stage the final confrontation where the inner change is proven through outer action. Let the protagonist win or lose on their own terms.",
    },
    {
      title: "Resolution",
      summary:
        "Show the new equilibrium and what the journey cost and earned. Echo the opening image so the change reads on screen.",
    },
  ];
}

function saveTheCatBeats(): ScriptStructureBeat[] {
  return [
    {
      title: "Opening Image",
      summary:
        "A snapshot of the hero's life before the story — tone, mood, and stakes in one scene. This is the 'before' photo the finale will answer.",
    },
    {
      title: "Theme Stated",
      summary:
        "Someone tells the hero the lesson they need to learn, usually in passing dialogue they brush off. State it early so the ending can prove it.",
    },
    {
      title: "Set-Up",
      summary:
        "Tour the hero's home, work, and play while planting every character and flaw the story will pay off. Show exactly what needs fixing in their life.",
    },
    {
      title: "Catalyst",
      summary:
        "A life-changing piece of news or event knocks the hero's world sideways. Make it land in a single scene with no take-backs.",
    },
    {
      title: "Debate",
      summary:
        "The hero hesitates: can I do this, should I do this? Pose the question sharply so the choice to act carries real weight.",
    },
    {
      title: "Break into Two",
      summary:
        "The hero makes a proactive choice and steps into the upside-down version of their world. Act Two should feel like a different movie.",
    },
    {
      title: "B Story",
      summary:
        "Introduce the relationship — love interest, mentor, friend — that carries the theme. The B story gives the hero room to discuss the lesson out loud.",
    },
    {
      title: "Fun and Games",
      summary:
        "Deliver the promise of the premise — the set pieces and trailer moments the audience came for. The hero explores the new world, winning or flailing.",
    },
    {
      title: "Midpoint",
      summary:
        "A false victory or false defeat raises the stakes and fuses the A and B stories. Time clocks start ticking here.",
    },
    {
      title: "Bad Guys Close In",
      summary:
        "External enemies regroup while internal doubts fester. The hero's team frays as pressure mounts from every direction.",
    },
    {
      title: "All Is Lost",
      summary:
        "The hero loses everything gained and hits bottom. Add a whiff of death to mark the old self dying.",
    },
    {
      title: "Dark Night of the Soul",
      summary:
        "Let the hero sit in the loss and grieve what's gone. This is where they finally absorb the theme stated long ago.",
    },
    {
      title: "Break into Three",
      summary:
        "Thanks to the B story and the theme, the hero finds the solution and chooses to fight. Synthesis: old-world skills plus new-world lessons.",
    },
    {
      title: "Finale",
      summary:
        "The hero executes the new plan, dispatches the bad guys in ascending order, and proves the transformation in action.",
    },
    {
      title: "Final Image",
      summary:
        "The mirror of the opening image, showing how much the hero and their world have changed. No change, no story.",
    },
  ];
}

function storyCircleBeats(): ScriptStructureBeat[] {
  return [
    {
      title: "You",
      summary:
        "Establish the protagonist in their zone of comfort. Show the routine — and the itch underneath it — in concrete daily behavior.",
    },
    {
      title: "Need",
      summary:
        "Surface the want, and beneath it the deeper need, that the comfort zone can't satisfy. Make the audience feel the lack before anyone names it.",
    },
    {
      title: "Go",
      summary:
        "The protagonist crosses a threshold into an unfamiliar situation. Mark the border clearly; the rules change on the other side.",
    },
    {
      title: "Search",
      summary:
        "Adapt or suffer: the protagonist experiments, struggles, and pays road tolls in the new world. Each trial teaches the rules.",
    },
    {
      title: "Find",
      summary:
        "The protagonist gets what they were after — and it isn't quite what they expected. The want is met just as its true cost appears.",
    },
    {
      title: "Take",
      summary:
        "Pay the heavy price for the prize. Something real is lost or sacrificed, and the protagonist is changed by paying it.",
    },
    {
      title: "Return",
      summary:
        "Head back to the familiar world carrying the prize and the scars. The journey home tests whether the change holds.",
    },
    {
      title: "Change",
      summary:
        "Show the protagonist mastering their old world with new understanding. The circle closes; the change is visible to everyone.",
    },
  ];
}

function fiveActBeats(): ScriptStructureBeat[] {
  return [
    {
      title: "Cold Open",
      summary:
        "Hook the audience before the titles with a question, a body, a joke, or a problem only this episode can answer. End it on a sting.",
    },
    {
      title: "Act One — Setup",
      summary:
        "Lay out the episode's central problem and what each lead wants from it. End the act on a turn that makes the problem worse or personal.",
    },
    {
      title: "Act Two — Complication",
      summary:
        "The first plan fails, and the failure exposes character. Layer in the runner or subplot that will collide with the A-story later.",
    },
    {
      title: "Act Three — Midpoint Turn",
      summary:
        "Reframe the problem with a reveal or reversal — what they thought they were solving isn't the real issue. Send the leads in a new direction.",
    },
    {
      title: "Act Four — Crisis",
      summary:
        "Push the conflict to its worst point as options run out. End the act on the decision that triggers the climax.",
    },
    {
      title: "Act Five — Climax",
      summary:
        "Resolve the episode's problem in a way that costs or teaches the leads something. Land the subplot inside the A-story payoff.",
    },
    {
      title: "Tag",
      summary:
        "A short closing beat after the climax — a laugh, a grace note, or a hook for next week. Leave the audience with the episode's flavor.",
    },
  ];
}

function sitcomAbBeats(): ScriptStructureBeat[] {
  return [
    {
      title: "Cold Open",
      summary:
        "A fast, self-contained gag or hook that sets the episode's energy. It can seed the theme, but it must land a laugh on its own.",
    },
    {
      title: "A-Story Setup",
      summary:
        "Launch the main plot with a clear want for the lead and an obstacle with comic potential. State the stakes in a single scene.",
    },
    {
      title: "B-Story Setup",
      summary:
        "Spin up the secondary plot with different characters and a contrasting tone. Keep its engine simple enough to run in half the scenes.",
    },
    {
      title: "A-Story Complication",
      summary:
        "The lead's first attempt backfires and doubles the trouble. The lie gets bigger, the scheme gets riskier, the hole gets deeper.",
    },
    {
      title: "B-Story Complication",
      summary:
        "Escalate the B-plot in parallel, ideally so its stakes start drifting toward the A-plot's territory. The audience should sense the collision coming.",
    },
    {
      title: "Stories Collide",
      summary:
        "Bring both plots crashing into the same room at the worst possible moment. The collision should force the episode's funniest, most revealing scene.",
    },
    {
      title: "Resolution",
      summary:
        "Untangle the mess in a way that says something small but true about the characters. Comedic justice: everyone gets what they deserve, not what they want.",
    },
    {
      title: "Tag",
      summary:
        "One last button on the episode — a callback or runner payoff over the credits. Short, sharp, done.",
    },
  ];
}

function singleTurnBeats(): ScriptStructureBeat[] {
  return [
    {
      title: "Setup",
      summary:
        "Establish a character, a want, and a situation in the fewest possible strokes — the first image should already carry tension. Every prop and line must earn its place.",
    },
    {
      title: "Turn",
      summary:
        "One irreversible surprise, reveal, or decision that reframes everything the audience just saw. The turn is the film; stage it cleanly.",
    },
    {
      title: "Payoff",
      summary:
        "Land the consequence of the turn and get out. The last image should answer — or deliberately reopen — the first.",
    },
  ];
}

function miniArcBeats(): ScriptStructureBeat[] {
  return [
    {
      title: "Hook",
      summary:
        "Open inside a moment that raises an immediate question. In a short, the first thirty seconds buys the rest of the runtime.",
    },
    {
      title: "Want",
      summary:
        "Make the protagonist's desire concrete and visible — something we can watch them pursue rather than hear about.",
    },
    {
      title: "Obstacle",
      summary:
        "Put one strong obstacle between character and want, and let it expose who they are under pressure. One obstacle, fully dramatized, beats three sketched.",
    },
    {
      title: "Choice",
      summary:
        "Force a decision with real cost — shorts turn on choices, not coincidences. What the character picks is the film's argument.",
    },
    {
      title: "Aftermath",
      summary:
        "Show the price or the prize in a single resonant image or beat. Resist explaining; let the consequence speak.",
    },
  ];
}

function twoActStageBeats(): ScriptStructureBeat[] {
  return [
    {
      title: "Cold Open Image",
      summary:
        "Begin with a stage picture that announces the world, tone, and central tension before a line is spoken. The set, light, and bodies should already be in argument.",
    },
    {
      title: "Act One — World & Want",
      summary:
        "Establish the place, the relationships, and what the protagonist wants out loud. Theatre runs on spoken desire; let characters say what they're after.",
    },
    {
      title: "Act One — Complication",
      summary:
        "Introduce the pressure that makes the want hard to get — an arrival, a secret, a deadline confined to this room. Tighten the space rather than widening it.",
    },
    {
      title: "Act One — Curtain Question",
      summary:
        "End the act on a question the audience must return to have answered. The interval should be spent taking sides.",
    },
    {
      title: "Act Two — Fallout",
      summary:
        "Open after the turn and dramatize the consequences — alliances have shifted over the interval. Let the audience catch up through behavior, not recap.",
    },
    {
      title: "Act Two — Confrontation",
      summary:
        "Drive the central characters into the argument they've been avoiding all night. Long-suppressed truths surface in real time, on stage.",
    },
    {
      title: "Climax On Stage",
      summary:
        "Stage the decisive action in front of the audience — no offstage rescue. Theatre's contract is that the cost is paid in view.",
    },
    {
      title: "Final Image",
      summary:
        "Close on a stage picture that answers the opening one. What changed should be legible in who stands where, and in what light.",
    },
  ];
}
