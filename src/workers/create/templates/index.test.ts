import { describe, expect, it } from 'vitest';
import { TEMPLATES, getTemplate, listTemplateMetadata } from './index';

describe('templates registry', () => {
  it('exposes hero-journey with all required fields', () => {
    const t = getTemplate('hero-journey');
    expect(t).not.toBeNull();
    expect(t!.id).toBe('hero-journey');
    expect(t!.questions.length).toBeGreaterThanOrEqual(5);
    expect(t!.scenePlan.length).toBeGreaterThan(0);
    expect(t!.voice.profile).toBe('warm');
    expect(t!.voice.pacingWpm).toBe(150);
    expect(t!.systemPromptFragment.length).toBeGreaterThan(40);
    for (const q of t!.questions) {
      expect(q.id).toMatch(/^[a-z][a-z0-9-]*$/);
      expect(q.text.length).toBeGreaterThan(8);
    }
  });

  it('listTemplateMetadata strips question text', () => {
    const meta = listTemplateMetadata();
    expect(meta).toHaveLength(1);
    expect(meta[0].id).toBe('hero-journey');
    expect((meta[0] as unknown as { questions?: unknown }).questions).toBeUndefined();
  });

  it('getTemplate returns null for unknown id', () => {
    expect(getTemplate('made-up')).toBeNull();
  });
});
