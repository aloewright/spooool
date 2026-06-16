import type { MiddlewareHandler } from "hono";
import type { Env } from "../env";

export const errorHandler: MiddlewareHandler<{ Bindings: Env }> = async (c, next) => {
  await next();
  if (c.error) {
    const e = c.error as Error;
    const code = e.name === "BudgetExceeded" ? 402 : e.name === "Unauthorized" ? 401 : 500;
    console.error("error", e.name, e.message);
    c.res = c.json({ error: { code: e.name, message: e.message } }, code);
  }
};
