import type { MiddlewareHandler } from "hono";
import type { Env } from "../env";
import { assertBudget } from "../lib/budget";
import type { AuthVariables } from "./auth";

export const enforceBudget =
  (
    _route: string,
  ): MiddlewareHandler<{
    Bindings: Env;
    Variables: AuthVariables;
  }> =>
  async (c, next) => {
    const user = c.get("user");
    // For now use a fixed cap from env defaults; per-user override comes in a later phase.
    const cap = user.plan === "pro" ? 5000 : 1000;
    await assertBudget(c.env.KV, user.id, cap);
    await next();
  };
