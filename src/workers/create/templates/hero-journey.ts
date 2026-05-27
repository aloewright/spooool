import type { StoryTemplate } from './types';

export const heroJourney: StoryTemplate = {
  id: 'hero-journey',
  name: "The Hero's Journey",
  description:
    'A short narrative arc — ordinary world → call to adventure → transformation. Best for 60-90 second character-driven explainers.',
  questions: [
    {
      id: 'protagonist',
      text: 'Who is the protagonist? (one sentence)',
      hint: 'e.g., a new developer learning Cloudflare Workers',
    },
    { id: 'ordinary-world', text: 'What is their ordinary world before things change?' },
    { id: 'inciting-incident', text: 'What forces them out of that ordinary world?' },
    { id: 'false-belief', text: 'What false belief or lie were they operating under?' },
    { id: 'turning-point', text: 'What pressure forces them to confront the truth?' },
    { id: 'transformation', text: 'What does the protagonist look like after the change?' },
    {
      id: 'closing-truth',
      text: 'What single line should the viewer remember?',
      hint: 'a punchy takeaway',
    },
  ],
  systemPromptFragment:
    "You are writing a 60-90 second narrative explainer following the hero's journey arc. Keep the language vivid and concrete; one beat per scene. Use second-person ('you') only if it fits the answers.",
  scenePlan: [
    { beatId: 'ordinary-world', questionIds: ['protagonist', 'ordinary-world'], durationSeconds: 10 },
    { beatId: 'call-to-adventure', questionIds: ['inciting-incident'], durationSeconds: 10 },
    { beatId: 'tension', questionIds: ['false-belief', 'turning-point'], durationSeconds: 20 },
    { beatId: 'transformation', questionIds: ['transformation'], durationSeconds: 15 },
    { beatId: 'outro', questionIds: ['closing-truth'], durationSeconds: 8 },
  ],
  voice: { profile: 'warm', pacingWpm: 150 },
};
