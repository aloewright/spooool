import type { Context } from 'hono';

/** Schedule background work when running inside a Worker; no-op in unit tests. */
export function waitUntilBackground(c: Context, promise: Promise<unknown>): void {
  try {
    c.executionCtx.waitUntil(promise);
  } catch {
    void promise;
  }
}
