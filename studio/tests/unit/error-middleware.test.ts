import { Hono } from "hono";
import { describe, expect, it } from "vitest";
import { errorHandler } from "../../apps/web/src/middleware/error";

function makeApp(throwFn: () => never) {
  const app = new Hono();
  app.use(errorHandler);
  app.get("/", () => throwFn());
  return app;
}

describe("errorHandler middleware", () => {
  it("returns 402 for BudgetExceeded errors", async () => {
    const app = makeApp(() => {
      const err = new Error("BudgetExceeded: user=u1 cap=1000");
      err.name = "BudgetExceeded";
      throw err;
    });
    const res = await app.request("/");
    expect(res.status).toBe(402);
    const body = await res.json();
    expect(body.error.code).toBe("BudgetExceeded");
  });

  it("returns 401 for Unauthorized errors", async () => {
    const app = makeApp(() => {
      const err = new Error("Unauthorized");
      err.name = "Unauthorized";
      throw err;
    });
    const res = await app.request("/");
    expect(res.status).toBe(401);
    const body = await res.json();
    expect(body.error.code).toBe("Unauthorized");
  });

  it("returns 500 for unexpected errors", async () => {
    const app = makeApp(() => {
      throw new Error("something went wrong");
    });
    const res = await app.request("/");
    expect(res.status).toBe(500);
    const body = await res.json();
    expect(body.error.message).toBe("something went wrong");
  });

  it("includes the error message in the response body", async () => {
    const app = makeApp(() => {
      const err = new Error("over limit");
      err.name = "BudgetExceeded";
      throw err;
    });
    const res = await app.request("/");
    const body = await res.json();
    expect(body.error.message).toBe("over limit");
  });
});
