// Thin client for the Loops (loops.so) email API. Three operations only —
// upsert a contact, unsubscribe a contact, and send a lifecycle event — so
// the surface stays small and other modules don't grow direct fetch calls.
//
// Design:
// - All operations fail-open (return a result object describing what
//   happened) so a flaky Loops upstream can never take down the calling
//   request path. Lifecycle email is best-effort.
// - No throws on missing API key; caller can branch on result.skipped.
// - Pure helpers (buildHeaders, parseLoopsError) extracted for unit tests.

const LOOPS_API_BASE = 'https://app.loops.so/api/v1';

export interface LoopsEnv {
  /** REST API key from https://app.loops.so/settings/api . */
  LOOPS_API_KEY?: string;
}

export interface LoopsContact {
  email: string;
  firstName?: string;
  lastName?: string;
  userId?: string;
  /** Arbitrary contact properties; mapped to Loops custom fields. */
  customProperties?: Record<string, string | number | boolean | null>;
  subscribed?: boolean;
}

export type LoopsResult =
  | { ok: true; status: number }
  | { ok: false; skipped: true; reason: string }
  | { ok: false; skipped: false; status: number; message: string };

export function buildHeaders(apiKey: string): Record<string, string> {
  return {
    Authorization: `Bearer ${apiKey}`,
    'Content-Type': 'application/json',
  };
}

export async function parseLoopsError(res: Response): Promise<string> {
  try {
    const body = (await res.json()) as { message?: string; error?: string } | null;
    return body?.message ?? body?.error ?? `Loops API ${res.status}`;
  } catch {
    return `Loops API ${res.status}`;
  }
}

async function request(
  method: 'POST' | 'PUT',
  endpoint: string,
  apiKey: string,
  body: unknown,
): Promise<LoopsResult> {
  let res: Response;
  try {
    res = await fetch(`${LOOPS_API_BASE}${endpoint}`, {
      method,
      headers: buildHeaders(apiKey),
      body: JSON.stringify(body),
    });
  } catch (err) {
    return {
      ok: false,
      skipped: false,
      status: 0,
      message: err instanceof Error ? err.message : String(err),
    };
  }
  if (res.ok) return { ok: true, status: res.status };
  const message = await parseLoopsError(res);
  return { ok: false, skipped: false, status: res.status, message };
}

// Upsert a contact by email. PUT /v1/contacts/update creates the contact if
// it doesn't exist and merges properties otherwise — perfect for a signup
// webhook that may fire more than once.
export async function upsertContact(
  env: LoopsEnv,
  contact: LoopsContact,
): Promise<LoopsResult> {
  if (!env.LOOPS_API_KEY) {
    return { ok: false, skipped: true, reason: 'LOOPS_API_KEY not configured' };
  }
  return request('PUT', '/contacts/update', env.LOOPS_API_KEY, contact);
}

// Mark a contact as unsubscribed. Used on account deletion so we don't keep
// mailing former users. We don't delete the contact — the user may rejoin
// and Loops needs the unsubscribed state for compliance.
export async function unsubscribeContact(
  env: LoopsEnv,
  email: string,
): Promise<LoopsResult> {
  if (!env.LOOPS_API_KEY) {
    return { ok: false, skipped: true, reason: 'LOOPS_API_KEY not configured' };
  }
  return request('PUT', '/contacts/update', env.LOOPS_API_KEY, {
    email,
    subscribed: false,
  });
}

// Trigger a Loops "event" — used by lifecycle automations defined in the
// Loops dashboard. eventName must match a configured trigger; properties
// are merged into the email template.
export async function sendEvent(
  env: LoopsEnv,
  args: {
    email: string;
    eventName: string;
    eventProperties?: Record<string, string | number | boolean | null>;
    /** Loops also accepts userId-only addressing for users without an email
        yet on file — rare for our flow, included for completeness. */
    userId?: string;
  },
): Promise<LoopsResult> {
  if (!env.LOOPS_API_KEY) {
    return { ok: false, skipped: true, reason: 'LOOPS_API_KEY not configured' };
  }
  return request('POST', '/events/send', env.LOOPS_API_KEY, {
    email: args.email,
    eventName: args.eventName,
    eventProperties: args.eventProperties ?? {},
    userId: args.userId,
  });
}
