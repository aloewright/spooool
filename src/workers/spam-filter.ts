// ALO-154: lightweight, deterministic spam pre-filter for comments.
// Designed as a hook so we can swap in an AI Gateway dynamic-route classifier
// later without touching call sites.

export interface SpamCheckResult {
  blocked: boolean;
  reason?: 'too_short' | 'link_spam' | 'all_caps' | 'repeat_chars';
}

const URL_RE = /https?:\/\/\S+/gi;

export function isLikelySpam(body: string): SpamCheckResult {
  const trimmed = body.trim();
  if (trimmed.length === 0) return { blocked: true, reason: 'too_short' };

  // > 3 links in a single comment is almost always spam at this scale.
  const urlMatches = trimmed.match(URL_RE);
  if (urlMatches && urlMatches.length > 3) {
    return { blocked: true, reason: 'link_spam' };
  }

  // ALL-CAPS shouting longer than ~20 letters.
  const letters = trimmed.replace(/[^A-Za-z]/g, '');
  if (letters.length > 20 && letters === letters.toUpperCase()) {
    return { blocked: true, reason: 'all_caps' };
  }

  // Same character repeated >= 12 times in a row (zalgo-ish floods).
  if (/(.)\1{11,}/.test(trimmed)) {
    return { blocked: true, reason: 'repeat_chars' };
  }

  return { blocked: false };
}

interface AiBinding {
  run(
    model: string,
    inputs: Record<string, unknown>,
    options?: Record<string, unknown>,
  ): Promise<unknown>;
}

export interface AiSpamEnv {
  AI?: AiBinding;
  CF_ACCOUNT_ID?: string;
  CF_GATEWAY_ID?: string;
  CF_AIG_TOKEN?: string;
}

export interface AiSpamScore {
  spam: boolean;
  reason: string;
}

const SPAM_SYSTEM_PROMPT =
  'You are a comment spam classifier. Respond with ONLY a JSON object: ' +
  '{"spam": boolean, "reason": string}. ' +
  'Set spam=true for: phishing, AI-written promotional copypasta, off-topic advertising, ' +
  'or subtle manipulation. Set spam=false for genuine user comments.';

export async function scoreCommentWithAi(
  env: AiSpamEnv,
  body: string,
): Promise<AiSpamScore | null> {
  const messages = [
    { role: 'system', content: SPAM_SYSTEM_PROMPT },
    { role: 'user', content: body },
  ];

  try {
    if (env.AI) {
      const gatewayId = env.CF_GATEWAY_ID ?? 'spooool';
      const result = await env.AI.run(
        'dynamic/text_gen',
        { messages },
        { gateway: { id: gatewayId } },
      );
      return parseAiResponse(result);
    }

    if (env.CF_ACCOUNT_ID && env.CF_AIG_TOKEN) {
      const gatewayId = env.CF_GATEWAY_ID ?? 'spooool';
      const url = `https://gateway.ai.cloudflare.com/v1/${env.CF_ACCOUNT_ID}/${gatewayId}/workers-ai/dynamic/text_gen`;
      const res = await fetch(url, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${env.CF_AIG_TOKEN}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ messages }),
      });
      if (!res.ok) return null;
      const data = (await res.json()) as unknown;
      return parseAiResponse(data);
    }
  } catch {
    // Gateway errors must not block users — fall through to allow.
  }

  return null;
}

function parseAiResponse(result: unknown): AiSpamScore | null {
  try {
    let text: string;
    if (typeof result === 'string') {
      text = result;
    } else if (result !== null && typeof result === 'object') {
      const r = result as Record<string, unknown>;
      const inner = (r.result ?? r) as Record<string, unknown>;
      text = typeof inner.response === 'string' ? inner.response : JSON.stringify(inner);
    } else {
      return null;
    }

    const match = text.match(/\{[^{}]+\}/);
    if (!match) return null;
    const parsed = JSON.parse(match[0]) as Record<string, unknown>;
    if (typeof parsed.spam === 'boolean' && typeof parsed.reason === 'string') {
      return { spam: parsed.spam, reason: parsed.reason };
    }
  } catch {
    // ignore parse errors
  }
  return null;
}
