import { and, count, desc, eq, gte, isNotNull, isNull, like, ne, sql, sum } from "drizzle-orm";
import { drizzle } from "drizzle-orm/d1";
import { Hono } from "hono";
import { z } from "zod";
import { chapters, projects, render_jobs, usage_daily, users } from "../db/schema";
import type { Env } from "../env";
import { type AuthVariables, requireAdmin, requireUser } from "../middleware/auth";

export const adminRoute = new Hono<{ Bindings: Env; Variables: AuthVariables }>()
  // GET /me — any signed-in user can call this; returns { is_admin: boolean }.
  // Used by the client to decide whether to render the Admin nav link.
  .get("/me", requireUser, async (c) => {
    const db = drizzle(c.env.DB);
    const user = c.get("user");
    const row = await db
      .select({ is_admin: users.is_admin })
      .from(users)
      .where(eq(users.id, user.id))
      .limit(1);
    return c.json({ is_admin: !!row[0]?.is_admin });
  })
  .use("*", requireAdmin)
  .get("/stats", async (c) => {
    const db = drizzle(c.env.DB);
    const sevenDaysAgo = new Date(Date.now() - 1000 * 60 * 60 * 24 * 7);

    const [usersTotal] = await db.select({ n: count() }).from(users);
    const [usersNew7d] = await db
      .select({ n: count() })
      .from(users)
      .where(gte(users.createdAt, sevenDaysAgo));
    const [projectsActive] = await db
      .select({ n: count() })
      .from(projects)
      .where(isNull(projects.deleted_at));
    const [projectsDeleted] = await db
      .select({ n: count() })
      .from(projects)
      .where(isNotNull(projects.deleted_at));
    const [chaptersTotal] = await db.select({ n: count() }).from(chapters);
    const [chaptersDrafted] = await db
      .select({ n: count() })
      .from(chapters)
      .where(and(isNotNull(chapters.draft_md), ne(chapters.draft_md, "")));
    const [renderCompleted] = await db
      .select({ n: count() })
      .from(render_jobs)
      .where(eq(render_jobs.status, "completed"));
    const [renderFailed] = await db
      .select({ n: count() })
      .from(render_jobs)
      .where(eq(render_jobs.status, "failed"));
    const [renderRunning] = await db
      .select({ n: count() })
      .from(render_jobs)
      .where(eq(render_jobs.status, "running"));
    const [usageCents] = await db.select({ s: sum(usage_daily.cost_cents) }).from(usage_daily);
    const [renderCents] = await db.select({ s: sum(render_jobs.cost_cents) }).from(render_jobs);

    return c.json({
      users: { total: usersTotal?.n ?? 0, new_7d: usersNew7d?.n ?? 0 },
      projects: {
        active: projectsActive?.n ?? 0,
        deleted: projectsDeleted?.n ?? 0,
      },
      chapters: { total: chaptersTotal?.n ?? 0, drafted: chaptersDrafted?.n ?? 0 },
      render_jobs: {
        completed: renderCompleted?.n ?? 0,
        failed: renderFailed?.n ?? 0,
        running: renderRunning?.n ?? 0,
      },
      compute_spend_cents: Number(usageCents?.s ?? 0) + Number(renderCents?.s ?? 0),
      subscription_revenue_cents: 0,
      subscription_provider: "not_connected",
    });
  })
  .get("/users", async (c) => {
    const db = drizzle(c.env.DB);
    const q = (c.req.query("q") ?? "").trim();
    const limit = Math.min(Number(c.req.query("limit") ?? 50), 200);
    const offset = Math.max(Number(c.req.query("offset") ?? 0), 0);

    const where = q ? like(users.email, `%${q}%`) : undefined;

    const items = await db
      .select({
        id: users.id,
        email: users.email,
        name: users.name,
        plan: users.plan,
        phase: users.phase,
        is_admin: users.is_admin,
        daily_budget_cents: users.daily_budget_cents,
        createdAt: users.createdAt,
        updatedAt: users.updatedAt,
      })
      .from(users)
      .where(where)
      .orderBy(desc(users.createdAt))
      .limit(limit)
      .offset(offset);

    const [{ n }] = await db.select({ n: count() }).from(users).where(where);

    // Per-user counts: projects.
    const projectCounts = items.length
      ? await db
          .select({
            user_id: projects.user_id,
            n: count(),
          })
          .from(projects)
          .where(isNull(projects.deleted_at))
          .groupBy(projects.user_id)
      : [];
    const projectsByUser = new Map(projectCounts.map((r) => [r.user_id, r.n]));

    return c.json({
      total: n,
      items: items.map((u) => ({
        ...u,
        project_count: projectsByUser.get(u.id) ?? 0,
      })),
    });
  })
  .get("/activity", async (c) => {
    const db = drizzle(c.env.DB);
    const recentUsers = await db
      .select({
        id: users.id,
        email: users.email,
        createdAt: users.createdAt,
      })
      .from(users)
      .orderBy(desc(users.createdAt))
      .limit(10);
    const recentProjects = await db
      .select({
        id: projects.id,
        title: projects.title,
        type: projects.type,
        created_at: projects.created_at,
        user_id: projects.user_id,
      })
      .from(projects)
      .where(isNull(projects.deleted_at))
      .orderBy(desc(projects.created_at))
      .limit(10);
    const recentJobs = await db
      .select({
        id: render_jobs.id,
        kind: render_jobs.kind,
        status: render_jobs.status,
        cost_cents: render_jobs.cost_cents,
        started_at: render_jobs.started_at,
        project_id: render_jobs.project_id,
      })
      .from(render_jobs)
      .orderBy(desc(render_jobs.started_at))
      .limit(10);

    return c.json({
      recent_users: recentUsers,
      recent_projects: recentProjects,
      recent_render_jobs: recentJobs,
    });
  })
  .post("/users/:id/admin", async (c) => {
    const db = drizzle(c.env.DB);
    const body = z.object({ is_admin: z.boolean() }).parse(await c.req.json());
    const id = c.req.param("id");
    await db.update(users).set({ is_admin: body.is_admin }).where(eq(users.id, id));
    return c.json({ ok: true });
  });
