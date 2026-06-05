import { describe, expect, it } from 'vitest';
import { isLikelySpam, scoreCommentWithAi } from './spam-filter';
import type { AiSpamEnv } from './spam-filter';

describe('isLikelySpam', () => {
  it('allows normal comments', () => {
    expect(isLikelySpam('Great video, thanks for sharing!')).toEqual({ blocked: false });
    expect(isLikelySpam('check this http://example.com it was useful')).toEqual({
      blocked: false,
    });
  });

  it('blocks empty/whitespace bodies', () => {
    expect(isLikelySpam('')).toEqual({ blocked: true, reason: 'too_short' });
    expect(isLikelySpam('   ')).toEqual({ blocked: true, reason: 'too_short' });
  });

  it('blocks comments with more than three URLs', () => {
    const body = 'a http://x.com b https://y.com c http://z.com d https://q.com';
    expect(isLikelySpam(body)).toEqual({ blocked: true, reason: 'link_spam' });
  });

  it('blocks long ALL-CAPS shouting', () => {
    expect(isLikelySpam('THIS IS COMPLETELY UNACCEPTABLE BEHAVIOR FROM EVERYONE')).toEqual({
      blocked: true,
      reason: 'all_caps',
    });
  });

  it('allows short emphatic caps', () => {
    expect(isLikelySpam('LOL nice')).toEqual({ blocked: false });
  });

  it('blocks long character floods', () => {
    expect(isLikelySpam('aaaaaaaaaaaaaaaaaa')).toEqual({
      blocked: true,
      reason: 'repeat_chars',
    });
  });
});

describe('scoreCommentWithAi', () => {
  it('blocks when AI flags the comment as spam', async () => {
    const env: AiSpamEnv = {
      AI: {
        async run() {
          return { response: '{"spam": true, "reason": "promotional copypasta"}' };
        },
      },
    };
    const result = await scoreCommentWithAi(env, 'Buy cheap followers now at spamsite.biz!');
    expect(result).toEqual({ spam: true, reason: 'promotional copypasta' });
  });

  it('allows when AI classifies the comment as ham', async () => {
    const env: AiSpamEnv = {
      AI: {
        async run() {
          return { response: '{"spam": false, "reason": "genuine user comment"}' };
        },
      },
    };
    const result = await scoreCommentWithAi(env, 'Really enjoyed this, subscribed!');
    expect(result).toEqual({ spam: false, reason: 'genuine user comment' });
  });

  it('returns null on gateway error so the comment is allowed through', async () => {
    const env: AiSpamEnv = {
      AI: {
        async run(): Promise<unknown> {
          throw new Error('Gateway unavailable');
        },
      },
    };
    const result = await scoreCommentWithAi(env, 'Any comment body');
    expect(result).toBeNull();
  });

  it('returns null when no AI binding or HTTP credentials are configured', async () => {
    const result = await scoreCommentWithAi({}, 'Any comment body');
    expect(result).toBeNull();
  });

  it('parses JSON wrapped in prose from the model response', async () => {
    const env: AiSpamEnv = {
      AI: {
        async run() {
          return { response: 'Sure! Here is my verdict: {"spam": true, "reason": "phishing link"}' };
        },
      },
    };
    const result = await scoreCommentWithAi(env, 'Click here to claim your prize!');
    expect(result).toEqual({ spam: true, reason: 'phishing link' });
  });
});
