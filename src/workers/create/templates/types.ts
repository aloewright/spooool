export interface Question {
  id: string;
  text: string;
  hint?: string;
  multiline?: boolean;
}

export interface ScenePlanHint {
  beatId: string;
  questionIds: string[];
  durationSeconds: number;
}

export type VoiceProfile = 'neutral' | 'warm' | 'energetic';

export interface StoryTemplate {
  id: string;
  name: string;
  description: string;
  questions: Question[];
  systemPromptFragment: string;
  scenePlan: ScenePlanHint[];
  voice: { profile: VoiceProfile; pacingWpm: number };
}

export interface TemplateMetadata {
  id: string;
  name: string;
  description: string;
}
