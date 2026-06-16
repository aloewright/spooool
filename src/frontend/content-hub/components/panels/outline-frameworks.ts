// Outline framework catalog — the subset of
// studio/apps/web/client/components/panels/_shared.ts that the ported
// OutlineBuilderQA actually consumes.
//
// The studio `_shared.ts` also re-exports workspace-rail helpers (workflow
// statuses, publisher-pack validation, etc.) that pull in
// components/workspace/outline-rail — heavy panels deferred to PR-4. To keep
// this PR's surface to the project-workspace SHELL, only OUTLINE_FRAMEWORKS is
// ported here. Verbatim copy of the OUTLINE_FRAMEWORKS array.
export const OUTLINE_FRAMEWORKS = [
  {
    id: 'paas',
    type: 'nonfiction',
    label: 'Problem -> Agitate -> Solve',
    description: 'Direct nonfiction argument for promise-led practical books.',
    questions: [
      'What painful problem does the reader want solved?',
      'What has the reader already tried?',
      'What promise can this book credibly make?',
      'What proof, stories, or examples can support the method?',
    ],
  },
  {
    id: 'reader-transformation',
    type: 'nonfiction',
    label: 'Reader Transformation',
    description: 'Nonfiction arc from current state to changed behavior.',
    questions: [
      "What is the reader's current state?",
      'What transformation should the book deliver?',
      'What method, proof, or case studies support the promise?',
      'What should the reader do differently after each chapter?',
    ],
  },
  {
    id: 'hero-journey',
    type: 'fiction',
    label: "Hero's Journey",
    description: 'Classic quest structure for adventure-forward fiction.',
    questions: [
      'Who is the protagonist and what do they want?',
      'What wound or false belief keeps them stuck?',
      'What forces them out of the ordinary world?',
      'What choice proves they have changed?',
    ],
  },
  {
    id: 'truby-22',
    type: 'fiction',
    label: 'Truby-style 22 Beats',
    description: 'Dense cause-and-effect story architecture with moral pressure.',
    questions: [
      'What does the protagonist want on the surface?',
      'What deeper need or weakness must the plot expose?',
      'Who is the opponent and why are they morally persuasive?',
      'What final choice proves the protagonist has changed?',
    ],
  },
  {
    id: 'character-arc',
    type: 'fiction',
    label: 'Character Arc',
    description: 'K.M. Weiland-style want, need, lie, truth, and climactic choice.',
    questions: [
      'What lie or false belief drives the protagonist?',
      'What external want keeps them moving?',
      'What truth would make them whole?',
      'What pressure forces them to choose between the lie and the truth?',
    ],
  },
  {
    id: 'thriller',
    type: 'fiction',
    label: 'Thriller Escalation',
    description: 'Suspense-first outline with reversals, traps, and cliffhangers.',
    questions: [
      'What danger opens the book before anyone fully understands it?',
      'What personal stakes make retreat impossible?',
      'What does the antagonist know that the protagonist does not?',
      'What reversal changes the meaning of the investigation?',
    ],
  },
  {
    id: 'sci-fi',
    type: 'fiction',
    label: 'Sci-Fi World + Idea',
    description: 'Speculative premise, world rules, human cost, and ethical choice.',
    questions: [
      'What speculative premise changes ordinary life?',
      'What rule makes the world feel consistent?',
      'What human conflict keeps the idea emotional?',
      'What ethical choice should the ending force?',
    ],
  },
] as const;
