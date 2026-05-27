// src/frontend/create/lib/template.ts
// Re-export canonical template types from the worker module so both sides
// agree on shape. The worker is the source of truth.
export type { StoryTemplate, TemplateMetadata, Question, ScenePlanHint, VoiceProfile } from '../../../workers/create/templates/types';
