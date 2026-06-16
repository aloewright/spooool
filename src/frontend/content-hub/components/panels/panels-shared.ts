// Shared helpers for the PR-4 project panels — the trimmed subset of
// studio/apps/web/client/components/panels/_shared.ts that VoicePanel and
// PublishPanel actually use.
//
// The studio _shared.ts also exports outline-wizard data and a pile of workflow
// helpers that pull in `../workspace/outline-rail` (WorkflowKey / WorkflowStatus).
// None of that is reachable from the three PR-4 routes, so it is intentionally
// dropped here to avoid porting the workspace outline rail in this PR (same
// trimming convention the existing content-hub `outline-frameworks.ts` follows).
import type { PostPilotGuide, PublisherPack } from '../../lib/api';

export const POSTPILOT_SUGGESTIONS = [
  { slug: 'dickens', author: 'Charles Dickens', kicker: 'Victorian' },
  { slug: 'austen', author: 'Jane Austen', kicker: 'Regency' },
  { slug: 'twain', author: 'Mark Twain', kicker: 'American realism' },
  { slug: 'hemingway', author: 'Ernest Hemingway', kicker: 'Modernist' },
] as const;

export function postPilotGuideLabel(guide: Pick<PostPilotGuide, 'author' | 'kicker'>): string {
  return guide.kicker ? `${guide.author} · ${guide.kicker}` : guide.author;
}

export const FIELD_SLOT_IDS = ['one', 'two', 'three', 'four', 'five', 'six', 'seven'] as const;

export function parseVoiceIds(value: string): string[] {
  return value
    .split(/[,\n]/)
    .map((item) => item.trim())
    .filter(Boolean)
    .slice(0, 3);
}

export function sanitizePublisherDescription(value: string): string {
  return value
    .replace(/<(?!\/?(p|strong|em|ul|li|br)\b)[^>]*>/gi, '')
    .replace(/\son\w+\s*=\s*("[^"]*"|'[^']*'|[^\s>]+)/gi, '');
}

export function validateDraftPack(pack: PublisherPack): string[] {
  const errors: string[] = [];
  if (!pack.title.trim()) errors.push('Title is required.');
  if (pack.description_html.length > 4000) errors.push('Description is over 4000 characters.');
  if (pack.keywords.length !== 7 || pack.keywords.some((item) => !item.trim())) {
    errors.push('Fill all 7 keywords.');
  }
  if (pack.keywords.some((item) => item.length > 50)) {
    errors.push('Each keyword must be 50 characters or fewer.');
  }
  if (pack.bisac.length !== 2 || pack.bisac.some((item) => !item.trim())) {
    errors.push('Fill both BISAC categories.');
  }
  return errors;
}
