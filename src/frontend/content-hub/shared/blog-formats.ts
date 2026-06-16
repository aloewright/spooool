// Blog format catalog shared by the worker (validation, planning thresholds)
// and the client (compose wizard, structure picker). Each format curates its
// own audience options, structure templates, and series-planning minimums.

import { distributeBeats } from "./beat-plan";

export type BlogFormatId =
  | "serialized-fiction"
  | "how-to"
  | "opinion"
  | "case-study"
  | "listicle"
  | "interview"
  | "newsletter"
  | "transcript"
  | "interactive"
  | "meta";

export type BlogStructureBeat = {
  title: string;
  summary: string;
};

export type BlogStructure = {
  id: string;
  label: string;
  description: string;
  /**
   * Optional narrative beats (adapted from the book outlining frameworks).
   * When present, planning a series pre-titles the post slots with these
   * beats — one per post when the count allows, grouped or continued
   * otherwise. See planPostsForStructure.
   */
  beats?: BlogStructureBeat[];
};

export type BlogFormat = {
  id: BlogFormatId;
  emoji: string;
  shorthand: string;
  name: string;
  format: string;
  techExample: string;
  socialSciencesExample: string;
  bestFor: string;
  audienceOptions: string[];
  structures: BlogStructure[];
  /** Minimum posts planned per series for a cohesive run. */
  minPosts: number;
  defaultPosts: number;
  planningNote: string;
};

// The five cross-format story frameworks. Defined once here and reused by the
// script flow (src/shared/script-formats.ts) so books, blogs, and scripts all
// offer the same outlining structures. Beat summaries are story-craft guidance.
export const FICTION_FRAMEWORK_STRUCTURES: BlogStructure[] = [
  {
    id: "hero-journey",
    label: "Hero's Journey",
    description: "Classic quest structure for adventure-forward fiction.",
    beats: heroJourneyBeats(),
  },
  {
    id: "truby-22",
    label: "Truby-style 22 Beats",
    description: "Dense cause-and-effect story architecture with moral pressure.",
    beats: trubyBeats(),
  },
  {
    id: "character-arc",
    label: "Character Arc",
    description: "K.M. Weiland-style want, need, lie, truth, and climactic choice.",
    beats: characterArcBeats(),
  },
  {
    id: "thriller",
    label: "Thriller Escalation",
    description: "Suspense-first outline with reversals, traps, and cliffhangers.",
    beats: thrillerBeats(),
  },
  {
    id: "sci-fi",
    label: "Sci-Fi World + Idea",
    description: "Speculative premise, world rules, human cost, and ethical choice.",
    beats: sciFiBeats(),
  },
];

export const BLOG_FORMATS: BlogFormat[] = [
  {
    id: "serialized-fiction",
    emoji: "📖",
    shorthand: "Serialized fiction",
    name: "Serialized Fiction / Storytelling",
    format: "Each post is a chapter or episode in an ongoing story.",
    techExample: "A sci-fi series exploring AI ethics, with each post advancing the plot.",
    socialSciencesExample: "A fictional diary of a sociologist studying a dystopian society.",
    bestFor: "Building audience loyalty and long-term engagement.",
    audienceOptions: [
      "Fiction readers",
      "Genre fans",
      "Young adult readers",
      "Literary readers",
      "Fandom communities",
      "Binge readers",
    ],
    // The book outlining frameworks, adapted for serialized blog fiction:
    // each beat becomes (or shares) a planned post in the series.
    structures: FICTION_FRAMEWORK_STRUCTURES,
    minPosts: 8,
    defaultPosts: 8,
    planningNote:
      "Serial fiction needs runway — plan at least 8 posts so the arc lands. Picking a framework defaults to one post per beat.",
  },
  {
    id: "how-to",
    emoji: "🛠️",
    shorthand: "How-to / tutorials",
    name: "How-To / Tutorials",
    format: "Step-by-step guides solving a specific problem.",
    techExample: "“How to Build a REST API with Node.js in 10 Minutes.”",
    socialSciencesExample: "“How to Conduct a Qualitative Interview for Your Research.”",
    bestFor: "Establishing authority and driving search traffic.",
    audienceOptions: [
      "Beginners",
      "Practitioners",
      "Senior experts",
      "Students",
      "Career switchers",
      "Hobbyists",
    ],
    structures: [
      {
        id: "single-tutorial",
        label: "Single deep tutorial",
        description: "One complete walkthrough per post, from problem to working result.",
      },
      {
        id: "problem-solution-recipe",
        label: "Problem → solution recipe",
        description: "Short, repeatable posts: the problem, the fix, the gotchas.",
      },
      {
        id: "progressive-course",
        label: "Progressive course",
        description: "A beginner-to-advanced sequence where each post builds on the last.",
      },
    ],
    minPosts: 1,
    defaultPosts: 1,
    planningNote: "How-to posts stand alone — plan them one at a time if you like.",
  },
  {
    id: "opinion",
    emoji: "💬",
    shorthand: "Opinion / commentary",
    name: "Opinion / Commentary",
    format: "Personal takes on current events, trends, or theories.",
    techExample: "“Why Quantum Computing Won’t Replace Classical Computing Anytime Soon.”",
    socialSciencesExample: "“The Ethical Implications of AI in Social Work.”",
    bestFor: "Sparking discussion and building a voice.",
    audienceOptions: [
      "Industry insiders",
      "General readers",
      "Decision makers",
      "Academics",
      "Enthusiasts",
      "Skeptics",
    ],
    structures: [
      {
        id: "hot-take",
        label: "Hot take",
        description: "A sharp, timely reaction to something happening right now.",
      },
      {
        id: "argument-essay",
        label: "Argument essay",
        description: "Claim, evidence, counterpoint, conclusion — a built case per post.",
      },
      {
        id: "trend-column",
        label: "Trend column",
        description: "A recurring column responding to where your field is heading.",
      },
    ],
    minPosts: 1,
    defaultPosts: 2,
    planningNote: "Opinions can run solo, but a short run builds a recognizable voice.",
  },
  {
    id: "case-study",
    emoji: "🔍",
    shorthand: "Case studies / deep dives",
    name: "Case Studies / Deep Dives",
    format: "In-depth analysis of a single event, project, or phenomenon.",
    techExample: "“How GitHub’s Open Source Strategy Changed Software Development.”",
    socialSciencesExample: "“A Case Study on Community Resilience After Natural Disasters.”",
    bestFor: "Demonstrating expertise and providing real-world insights.",
    audienceOptions: [
      "Practitioners",
      "Researchers",
      "Founders & operators",
      "Students",
      "Analysts",
      "Consultants",
    ],
    structures: [
      {
        id: "chronological-narrative",
        label: "Chronological narrative",
        description: "Tell the story in order: setup, turning points, where it landed.",
      },
      {
        id: "problem-action-result",
        label: "Problem · Action · Result",
        description: "A structured breakdown of what was wrong, what was done, what changed.",
      },
      {
        id: "comparative-analysis",
        label: "Comparative analysis",
        description: "Two or more cases side by side to surface the pattern.",
      },
    ],
    minPosts: 1,
    defaultPosts: 1,
    planningNote: "Each deep dive stands on its own — plan one at a time.",
  },
  {
    id: "listicle",
    emoji: "📊",
    shorthand: "Listicles / roundups",
    name: "Listicles / Roundups",
    format: "Curated lists of tools, resources, or ideas.",
    techExample: "“10 AI Tools Every Developer Should Try in 2025.”",
    socialSciencesExample: "“7 Must-Read Books on Behavioral Economics.”",
    bestFor: "Quick reads and high shareability.",
    audienceOptions: [
      "Busy professionals",
      "Newcomers",
      "Tool shoppers",
      "Casual browsers",
      "Students",
      "Curators",
    ],
    structures: [
      {
        id: "ranked-countdown",
        label: "Ranked countdown",
        description: "An ordered list building to a number-one pick.",
      },
      {
        id: "curated-roundup",
        label: "Curated roundup",
        description: "An unranked collection with a short why-it-matters for each entry.",
      },
      {
        id: "themed-checklist",
        label: "Themed checklist",
        description: "An actionable list readers can work through and check off.",
      },
    ],
    minPosts: 1,
    defaultPosts: 1,
    planningNote: "Lists are snackable one-offs — plan as many as you have themes for.",
  },
  {
    id: "interview",
    emoji: "🧠",
    shorthand: "Interviews / Q&A",
    name: "Interviews / Q&A",
    format: "Conversations with experts, practitioners, or thought leaders.",
    techExample: "“Interview with a Senior ML Engineer at Google.”",
    socialSciencesExample: "“Q&A with a Climate Policy Researcher.”",
    bestFor: "Adding credibility and diverse perspectives.",
    audienceOptions: [
      "Aspiring professionals",
      "Industry peers",
      "Researchers",
      "Career changers",
      "Fans of the guests",
      "Recruiters & hiring managers",
    ],
    structures: [
      {
        id: "classic-qa",
        label: "Classic Q&A",
        description: "Question-and-answer transcript, lightly edited for flow.",
      },
      {
        id: "narrative-profile",
        label: "Narrative profile",
        description: "The conversation woven into a written profile of the guest.",
      },
      {
        id: "panel-roundup",
        label: "Panel roundup",
        description: "Several voices answering the same questions in one post.",
      },
    ],
    minPosts: 1,
    defaultPosts: 3,
    planningNote: "A short slate of guests keeps the series feeling intentional.",
  },
  {
    id: "newsletter",
    emoji: "📅",
    shorthand: "Daily/weekly updates",
    name: "Daily/Weekly Updates (Newsletter Style)",
    format: "Regular digest of news, thoughts, or progress.",
    techExample: "“This Week in Cybersecurity: Top 5 Threats.”",
    socialSciencesExample: "“Weekly Roundup: Key Papers in Sociology.”",
    bestFor: "Building a routine reader base.",
    audienceOptions: [
      "Daily readers",
      "Weekly readers",
      "Industry professionals",
      "Executives",
      "Researchers",
      "Community members",
    ],
    structures: [
      {
        id: "weekly-digest",
        label: "Weekly digest",
        description: "A fixed weekly rhythm of curated links and short commentary.",
      },
      {
        id: "daily-brief",
        label: "Daily brief",
        description: "Short, fast posts published every day on a tight template.",
      },
      {
        id: "progress-log",
        label: "Progress log",
        description: "A recurring update on what you shipped, learned, or read.",
      },
    ],
    minPosts: 4,
    defaultPosts: 4,
    planningNote: "Routine is the product — plan at least a month of issues up front.",
  },
  {
    id: "transcript",
    emoji: "🎙️",
    shorthand: "Podcast / video transcripts",
    name: "Podcast / Video Transcript Style",
    format: "Written versions of audio/video content.",
    techExample: "Transcripts of a tech podcast episode on blockchain.",
    socialSciencesExample: "Written summary of a panel discussion on urban inequality.",
    bestFor: "Repurposing multimedia content for SEO.",
    audienceOptions: [
      "Podcast listeners",
      "Video viewers",
      "Readers who skim",
      "Accessibility-first readers",
      "Researchers",
      "Search-driven readers",
    ],
    structures: [
      {
        id: "cleaned-transcript",
        label: "Cleaned transcript",
        description: "The full conversation, edited for readability and skimming.",
      },
      {
        id: "annotated-highlights",
        label: "Annotated highlights",
        description: "Key moments with timestamps and your added context.",
      },
      {
        id: "summary-and-quotes",
        label: "Summary + key quotes",
        description: "A tight written summary built around the best quotes.",
      },
    ],
    minPosts: 1,
    defaultPosts: 2,
    planningNote: "Pair each episode with a post — plan alongside your release schedule.",
  },
  {
    id: "interactive",
    emoji: "🧩",
    shorthand: "Interactive / experiential",
    name: "Interactive / Experiential",
    format: "Quizzes, polls, or choose-your-own-adventure style posts.",
    techExample: "“Which Programming Language Should You Learn Next?” (Quiz)",
    socialSciencesExample: "“What’s Your Political Ideology?” (Interactive Assessment)",
    bestFor: "High engagement and social sharing.",
    audienceOptions: [
      "Casual players",
      "Social sharers",
      "Self-assessors",
      "Students",
      "Communities",
      "Trend followers",
    ],
    structures: [
      {
        id: "quiz-series",
        label: "Quiz series",
        description: "Score-based quizzes with shareable results.",
      },
      {
        id: "choose-your-path",
        label: "Choose-your-own path",
        description: "Branching posts where reader choices steer the story.",
      },
      {
        id: "assessment-guide",
        label: "Assessment + results guide",
        description: "An interactive assessment paired with a deep-dive on each outcome.",
      },
    ],
    minPosts: 3,
    defaultPosts: 3,
    planningNote: "Chain at least three experiences together for a cohesive theme.",
  },
  {
    id: "meta",
    emoji: "🧪",
    shorthand: "Experimental / meta-blogging",
    name: "Experimental / Meta-Blogging",
    format: "Posts about the blog itself, its process, or failures.",
    techExample: "“How I Built This Blog Using Only Open-Source Tools.”",
    socialSciencesExample: "“Why I Started a Blog on Mental Health Stigma.”",
    bestFor: "Building authenticity and community.",
    audienceOptions: [
      "Fellow bloggers",
      "Makers & builders",
      "Your future readers",
      "Community supporters",
      "People starting out",
      "Process nerds",
    ],
    structures: [
      {
        id: "build-log",
        label: "Build log",
        description: "A running record of how the blog gets made, tools and all.",
      },
      {
        id: "retrospective",
        label: "Retrospective / post-mortem",
        description: "Honest looks back at what worked, what failed, and why.",
      },
      {
        id: "behind-the-scenes",
        label: "Behind the scenes",
        description: "The drafts, doubts, and decisions readers never usually see.",
      },
    ],
    minPosts: 1,
    defaultPosts: 3,
    planningNote: "A small opening arc of process posts builds trust fast.",
  },
];

export const BLOG_FORMAT_IDS = BLOG_FORMATS.map((f) => f.id) as [BlogFormatId, ...BlogFormatId[]];

export function getBlogFormat(id: string): BlogFormat | undefined {
  return BLOG_FORMATS.find((f) => f.id === id);
}

/**
 * Maps a structure's narrative beats onto `count` planned posts. One beat per
 * post when the count allows (extra posts continue their beat); when there
 * are fewer posts than beats, each post covers a contiguous group of beats.
 * Structures without beats produce untitled slots.
 */
export function planPostsForStructure(
  structure: BlogStructure | undefined,
  count: number,
): BlogStructureBeat[] {
  return distributeBeats(structure?.beats ?? [], count);
}

// ---------------------------------------------------------------------------
// Fiction framework beats, adapted from the book architect frameworks
// (src/skills/architect/frameworks) for serialized blog posts.

function heroJourneyBeats(): BlogStructureBeat[] {
  const overviews: [string, string][] = [
    [
      "Ordinary World",
      "Establish the protagonist's normal life, central lack, and the pressure that makes change necessary.",
    ],
    [
      "Call to Adventure",
      "Introduce the opportunity, threat, or summons that disrupts the old pattern and points toward the main story problem.",
    ],
    [
      "Refusal",
      "Show why the protagonist resists the call, what they fear losing, and why avoidance cannot hold.",
    ],
    [
      "Mentor",
      "Bring in guidance, leverage, warning, or a relationship test that reframes the journey ahead.",
    ],
    [
      "Threshold",
      "Force the protagonist across a point of no return where the old life can no longer solve the problem.",
    ],
    [
      "Tests",
      "Use escalating trials to teach the rules of the new world and expose weaknesses in the protagonist's plan.",
    ],
    [
      "Approach",
      "Narrow the goal, raise the stakes, and position the protagonist near the central ordeal.",
    ],
    [
      "Ordeal",
      "Put the protagonist through the deepest confrontation so the story's cost becomes unavoidable.",
    ],
    [
      "Reward",
      "Let the protagonist gain knowledge, power, evidence, or connection while revealing what it will cost to keep it.",
    ],
    [
      "Road Back",
      "Turn the victory into a new danger that forces the protagonist back toward the final conflict.",
    ],
    [
      "Resurrection",
      "Stage the final transformation test where the protagonist must act from the changed self.",
    ],
    [
      "Return",
      "Show the changed world, the earned consequence of the journey, and what the protagonist now brings back.",
    ],
  ];
  return overviews.map(([title, summary]) => ({
    title,
    summary: `${summary} End the post on a pull toward the next installment.`,
  }));
}

function trubyBeats(): BlogStructureBeat[] {
  const beats = [
    "Need and weakness",
    "Desire line",
    "Opponent pressure",
    "Plan",
    "Inciting disruption",
    "First revelation",
    "Drive",
    "Ally complications",
    "Apparent victory",
    "Opponent counterplan",
    "Midpoint revelation",
    "Moral pressure",
    "Bad turn",
    "New desire",
    "Gate and gauntlet",
    "Visit to death",
    "Battle choice",
    "Self-revelation",
    "Moral decision",
    "Final confrontation",
    "New equilibrium",
    "Afterimage",
  ];
  return beats.map((title) => ({
    title,
    summary: `Advance the ${title} beat as a cause-and-effect story turn — change the plan, the opposition, the moral pressure, or the protagonist's self-understanding by the end of the post.`,
  }));
}

function characterArcBeats(): BlogStructureBeat[] {
  const beats = [
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
  ];
  return beats.map((title) => ({
    title,
    summary: `Make the ${title} stage visible through an outer plot event and a specific inner shift in the protagonist's belief, desire, or choice.`,
  }));
}

function thrillerBeats(): BlogStructureBeat[] {
  const beats = [
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
  ];
  return beats.map((title) => ({
    title,
    summary: `Drive the ${title} beat with suspense first — a reveal, reversal, or tightening trap — and end on pressure that pulls readers to the next post.`,
  }));
}

function sciFiBeats(): BlogStructureBeat[] {
  const beats = [
    "World signal",
    "Human problem",
    "Impossible discovery",
    "Crossing the threshold",
    "Rules of the system",
    "First cost",
    "Faction pressure",
    "Paradigm shift",
    "Technology turns",
    "Ethical fracture",
    "Scale reveal",
    "Sacrifice design",
    "New future choice",
    "Changed world",
  ];
  return beats.map((title) => ({
    title,
    summary: `Ground the ${title} beat in the world's rules and its human cost, and sharpen the ethical stakes the ending must answer.`,
  }));
}
