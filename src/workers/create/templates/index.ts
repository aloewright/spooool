import { heroJourney } from './hero-journey';
import type { StoryTemplate, TemplateMetadata } from './types';

export const TEMPLATES: Record<string, StoryTemplate> = {
  [heroJourney.id]: heroJourney,
};

export function getTemplate(id: string): StoryTemplate | null {
  return TEMPLATES[id] ?? null;
}

export function listTemplateMetadata(): TemplateMetadata[] {
  return Object.values(TEMPLATES).map((t) => ({
    id: t.id,
    name: t.name,
    description: t.description,
  }));
}

export type { StoryTemplate, TemplateMetadata, Question, ScenePlanHint, VoiceProfile } from './types';
