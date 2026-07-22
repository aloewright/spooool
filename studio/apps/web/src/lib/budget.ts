export function todayIso(): string {
  return new Date().toISOString().slice(0, 10); // YYYY-MM-DD
}

export class BudgetExceeded extends Error {
  constructor(
    public readonly userId: string,
    public readonly cap: number,
  ) {
    super(`BudgetExceeded: user=${userId} cap=${cap}`);
    this.name = "BudgetExceeded";
  }
}

export type AiBudgetUsage = {
  route: "dynamic/text_gen" | "dynamic/research_gen" | "deterministic/local";
  tokens_in: number;
  tokens_out: number;
};

export type AiBudgetRoute = Exclude<AiBudgetUsage["route"], "deterministic/local">;

export type AiBudgetReservation = {
  requestId: string;
  userId: string;
  fingerprint: string;
  reservedCents: number;
};

export type AiBudgetReservationResult =
  | { state: "acquired"; reservation: AiBudgetReservation }
  | { state: "pending" }
  | {
      state: "staged";
      reservation: AiBudgetReservation;
      actualCents: number;
      revisionId: string;
      response: unknown;
    }
  | { state: "replay"; response: unknown }
  | { state: "conflict" };

export type AiRevisionToPersist = {
  id: string;
  targetTable: string;
  targetId: string;
  beforeMarkdown: string;
  afterMarkdown: string;
  llmResponse: AiBudgetUsage;
};

const RESERVATION_TTL_SECONDS = 60 * 60 * 26;
const PROMPT_ACCOUNTING_OVERHEAD_BYTES = 2_048;
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

type StoredBudgetRequest = {
  request_id: string;
  user_id: string;
  fingerprint: string;
  reserved_cents: number;
  actual_cents: number | null;
  status: "pending" | "generated" | "succeeded" | "failed";
  revision_id: string | null;
  response_json: string | null;
};

// Gateway routes may select different providers, so they cannot expose an
// exact provider invoice here. Meter a conservative, stable internal cost:
// output tokens count 3x input tokens and research calls count 2x text calls.
// A remote request always costs at least one cent; local deterministic work is
// free because it does not consume a hosted model.
export function aiUsageCostCents(usage: AiBudgetUsage): number {
  if (usage.route === "deterministic/local") return 0;
  const inputTokens = nonNegativeTokenCount(usage.tokens_in);
  const outputTokens = nonNegativeTokenCount(usage.tokens_out);
  const routeMultiplier = usage.route === "dynamic/research_gen" ? 2 : 1;
  return Math.max(1, Math.ceil(((inputTokens + outputTokens * 3) * routeMultiplier) / 1_000));
}

/**
 * Returns a conservative upper bound for one hosted call. A tokenizer cannot
 * emit more input tokens than the UTF-8 bytes sent to it, and the gateway caps
 * output tokens. Reserving this bound before the call makes settlement safe to
 * reduce atomically after the provider reports actual usage.
 */
export function aiReservationCostCents(
  route: AiBudgetRoute,
  serializedPrompt: string,
  maxOutputTokens: number,
): number {
  const inputBytes =
    new TextEncoder().encode(serializedPrompt).byteLength + PROMPT_ACCOUNTING_OVERHEAD_BYTES;
  return aiUsageCostCents({
    route,
    tokens_in: inputBytes,
    tokens_out: Math.max(0, Math.trunc(maxOutputTokens)),
  });
}

export function budgetCapCents(plan: "free" | "pro"): number {
  return plan === "pro" ? 5_000 : 1_000;
}

export function parseIdempotencyKey(value: string | undefined): string | null {
  const normalized = value?.trim().toLowerCase();
  return normalized && UUID_PATTERN.test(normalized) ? normalized : null;
}

export async function aiRequestFingerprint(parts: readonly unknown[]): Promise<string> {
  const bytes = new TextEncoder().encode(JSON.stringify(parts));
  const digest = await crypto.subtle.digest("SHA-256", bytes);
  return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, "0")).join("");
}

/**
 * Atomically reserves a request's conservative upper-bound cost in D1.
 * SQLite serializes the INSERT...SELECT statement, so concurrent requests for
 * one user cannot both observe the same remaining budget.
 */
export async function reserveAiBudgetRequest(
  db: D1Database,
  input: {
    requestId: string;
    userId: string;
    fingerprint: string;
    route: AiBudgetRoute;
    reservedCents: number;
    capCents: number;
  },
): Promise<AiBudgetReservationResult> {
  validatePositiveCents(input.reservedCents, "reserved cents");
  validatePositiveCents(input.capCents, "budget cap");

  const now = Math.floor(Date.now() / 1_000);
  const expiresAt = now + RESERVATION_TTL_SECONDS;
  const usageDate = todayIso();

  // D1 does not have native TTLs. Expired rows are ignored by every cap query
  // and opportunistically removed here, preserving the former 26-hour KV TTL.
  await db.prepare("DELETE FROM ai_budget_requests WHERE expires_at <= ?").bind(now).run();

  const inserted = await db
    .prepare(
      `INSERT INTO ai_budget_requests (
        request_id, user_id, usage_date, fingerprint, route,
        reserved_cents, actual_cents, status, revision_id, response_json,
        created_at, updated_at, expires_at
      )
      SELECT ?, ?, ?, ?, ?, ?, NULL, 'pending', NULL, NULL, ?, ?, ?
      WHERE COALESCE((
        SELECT SUM(
          CASE
            WHEN status IN ('pending', 'generated') THEN reserved_cents
            WHEN status = 'succeeded' THEN COALESCE(actual_cents, reserved_cents)
            ELSE 0
          END
        )
        FROM ai_budget_requests
        WHERE user_id = ?
          AND usage_date = ?
          AND expires_at > ?
          AND request_id <> ?
      ), 0) + ? <= ?
      ON CONFLICT(request_id) DO NOTHING
      RETURNING request_id`,
    )
    .bind(
      input.requestId,
      input.userId,
      usageDate,
      input.fingerprint,
      input.route,
      input.reservedCents,
      now,
      now,
      expiresAt,
      input.userId,
      usageDate,
      now,
      input.requestId,
      input.reservedCents,
      input.capCents,
    )
    .first<{ request_id: string }>();

  if (inserted) return acquiredReservation(input);

  let existing = await findBudgetRequest(db, input.requestId);
  if (!existing) throw new BudgetExceeded(input.userId, input.capCents);
  const terminal = terminalReservationResult(existing, input);
  if (terminal) return terminal;

  // A provider failure releases its reservation. The same key and fingerprint
  // may then retry by atomically re-acquiring capacity. Only one concurrent
  // retry can transition failed -> pending.
  const retried = await db
    .prepare(
      `UPDATE ai_budget_requests
      SET route = ?, usage_date = ?, reserved_cents = ?, actual_cents = NULL, status = 'pending',
          revision_id = NULL, response_json = NULL, updated_at = ?, expires_at = ?
      WHERE request_id = ?
        AND user_id = ?
        AND fingerprint = ?
        AND status = 'failed'
        AND COALESCE((
          SELECT SUM(
            CASE
              WHEN status IN ('pending', 'generated') THEN reserved_cents
              WHEN status = 'succeeded' THEN COALESCE(actual_cents, reserved_cents)
              ELSE 0
            END
          )
          FROM ai_budget_requests AS active_requests
          WHERE active_requests.user_id = ?
            AND active_requests.usage_date = ?
            AND active_requests.expires_at > ?
            AND active_requests.request_id <> ?
        ), 0) + ? <= ?
      RETURNING request_id`,
    )
    .bind(
      input.route,
      usageDate,
      input.reservedCents,
      now,
      expiresAt,
      input.requestId,
      input.userId,
      input.fingerprint,
      input.userId,
      usageDate,
      now,
      input.requestId,
      input.reservedCents,
      input.capCents,
    )
    .first<{ request_id: string }>();

  if (retried) return acquiredReservation(input);

  existing = await findBudgetRequest(db, input.requestId);
  if (!existing) throw new BudgetExceeded(input.userId, input.capCents);
  const retriedElsewhere = terminalReservationResult(existing, input);
  if (retriedElsewhere) return retriedElsewhere;
  throw new BudgetExceeded(input.userId, input.capCents);
}

/**
 * Persists the provider-complete result before revision settlement. If the
 * later transaction fails, the same idempotency key can finalize this staged
 * result without invoking the provider again.
 */
export async function stageAiBudgetRequest(
  db: D1Database,
  reservation: AiBudgetReservation,
  input: {
    actualCents: number;
    response: unknown;
    revisionId: string;
  },
): Promise<void> {
  if (!Number.isSafeInteger(input.actualCents) || input.actualCents < 0) {
    throw new TypeError("actual cents must be a non-negative safe integer");
  }
  if (input.actualCents > reservation.reservedCents) {
    throw new RangeError("actual cents exceeded the reserved upper bound");
  }

  const responseJson = JSON.stringify(input.response);
  const now = Math.floor(Date.now() / 1_000);
  const result = await db
    .prepare(
      `UPDATE ai_budget_requests
      SET actual_cents = ?, status = 'generated', revision_id = ?, response_json = ?, updated_at = ?
      WHERE request_id = ? AND user_id = ? AND fingerprint = ? AND status = 'pending'`,
    )
    .bind(
      input.actualCents,
      input.revisionId,
      responseJson,
      now,
      reservation.requestId,
      reservation.userId,
      reservation.fingerprint,
    )
    .run();
  if (result.meta.changes !== 1) {
    throw new Error("AI result staging lost its pending reservation");
  }
}

/** Atomically stores the revision and settles staged usage to actual cost. */
export async function completeAiBudgetRequest(
  db: D1Database,
  reservation: AiBudgetReservation,
  revision: AiRevisionToPersist,
): Promise<void> {
  const llmResponseJson = JSON.stringify(revision.llmResponse);
  const now = Math.floor(Date.now() / 1_000);
  const results = await db.batch([
    db
      .prepare(
        `INSERT INTO revisions (
          id, target_table, target_id, before_md, after_md, llm_response
        )
        SELECT ?, ?, ?, ?, ?, ?
        WHERE EXISTS (
          SELECT 1 FROM ai_budget_requests
          WHERE request_id = ? AND user_id = ? AND fingerprint = ?
            AND status = 'generated' AND revision_id = ?
        )`,
      )
      .bind(
        revision.id,
        revision.targetTable,
        revision.targetId,
        revision.beforeMarkdown,
        revision.afterMarkdown,
        llmResponseJson,
        reservation.requestId,
        reservation.userId,
        reservation.fingerprint,
        revision.id,
      ),
    db
      .prepare(
        `UPDATE ai_budget_requests
        SET status = 'succeeded', updated_at = ?
        WHERE request_id = ? AND user_id = ? AND fingerprint = ?
          AND status = 'generated' AND revision_id = ?`,
      )
      .bind(now, reservation.requestId, reservation.userId, reservation.fingerprint, revision.id),
  ]);

  if (results[0]?.meta.changes !== 1 || results[1]?.meta.changes !== 1) {
    const existing = await findBudgetRequest(db, reservation.requestId);
    if (
      existing?.user_id === reservation.userId &&
      existing.fingerprint === reservation.fingerprint &&
      existing.status === "succeeded" &&
      existing.revision_id === revision.id
    ) {
      return;
    }
    throw new Error("AI budget settlement lost its pending reservation");
  }
}

/** Releases a hosted reservation after a provider failure so the key can retry. */
export async function failAiBudgetRequest(
  db: D1Database,
  reservation: AiBudgetReservation,
): Promise<void> {
  await db
    .prepare(
      `UPDATE ai_budget_requests
      SET actual_cents = 0, status = 'failed', updated_at = ?
      WHERE request_id = ? AND user_id = ? AND fingerprint = ? AND status = 'pending'`,
    )
    .bind(
      Math.floor(Date.now() / 1_000),
      reservation.requestId,
      reservation.userId,
      reservation.fingerprint,
    )
    .run();
}

function acquiredReservation(input: {
  requestId: string;
  userId: string;
  fingerprint: string;
  reservedCents: number;
}): AiBudgetReservationResult {
  return {
    state: "acquired",
    reservation: {
      requestId: input.requestId,
      userId: input.userId,
      fingerprint: input.fingerprint,
      reservedCents: input.reservedCents,
    },
  };
}

async function findBudgetRequest(
  db: D1Database,
  requestId: string,
): Promise<StoredBudgetRequest | null> {
  return db
    .prepare(
      `SELECT request_id, user_id, fingerprint, reserved_cents, actual_cents,
        status, revision_id, response_json
      FROM ai_budget_requests WHERE request_id = ?`,
    )
    .bind(requestId)
    .first<StoredBudgetRequest>();
}

function terminalReservationResult(
  existing: StoredBudgetRequest,
  input: { userId: string; fingerprint: string },
): Exclude<AiBudgetReservationResult, { state: "acquired" }> | null {
  if (existing.user_id !== input.userId || existing.fingerprint !== input.fingerprint) {
    return { state: "conflict" };
  }
  if (existing.status === "pending") return { state: "pending" };
  if (existing.status === "generated") {
    if (
      !existing.response_json ||
      existing.actual_cents === null ||
      existing.revision_id === null
    ) {
      throw new Error("staged AI budget result is incomplete");
    }
    return {
      state: "staged",
      reservation: {
        requestId: existing.request_id,
        userId: existing.user_id,
        fingerprint: existing.fingerprint,
        reservedCents: existing.reserved_cents,
      },
      actualCents: existing.actual_cents,
      revisionId: existing.revision_id,
      response: JSON.parse(existing.response_json),
    };
  }
  if (existing.status === "succeeded") {
    if (!existing.response_json) throw new Error("AI budget replay response is missing");
    return { state: "replay", response: JSON.parse(existing.response_json) };
  }
  return null;
}

function validatePositiveCents(value: number, label: string): void {
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new TypeError(`${label} must be a positive safe integer`);
  }
}

function nonNegativeTokenCount(value: number): number {
  if (!Number.isFinite(value)) return 0;
  return Math.max(0, Math.trunc(value));
}
