import { type Page, expect, test } from "@playwright/test";

const now = 1_700_000_000_000;
const blog = {
  id: "ui-blog",
  title: "UI regression blog",
  format: "how-to",
  description: "",
  structure: "single-tutorial",
  planned_posts: 1,
  status: "drafting",
  emdash_site: null,
  created_at: now,
  updated_at: now,
  audience_json: [],
  voice_links_json: [],
  voice_uploads_json: [],
  voice_profile_md: "",
  rules_do_json: [],
  rules_dont_json: [],
};

const post = {
  id: "ui-post",
  blog_id: blog.id,
  ordinal: 1,
  title: "Editor regression",
  summary: "",
  draft_json: null,
  draft_md: "",
  status: "drafting",
  emdash_post_id: null,
  published_at: null,
  created_at: now,
  updated_at: now,
};

const script = {
  id: "ui-script",
  title: "UI regression script",
  format: "feature",
  logline: "",
  genre: null,
  structure: "three-act",
  planned_scenes: 1,
  status: "drafting",
  created_at: now,
  updated_at: now,
};

const scene = {
  id: "ui-scene",
  script_id: script.id,
  ordinal: 1,
  title: "Editor regression",
  summary: "",
  draft_json: null,
  draft_md: "",
  status: "drafting",
  created_at: now,
  updated_at: now,
};

async function mockEmptyEditors(page: Page) {
  await page.route("**/api/v1/**", async (route) => {
    const path = new URL(route.request().url()).pathname.replace(/^\/studio/, "");
    const method = route.request().method();
    let body: unknown;

    if (method === "GET" && path === "/api/v1/session") {
      body = {
        user: { id: "ui-user", name: "UI Test", email: "ui@example.test", plan: "pro" },
      };
    } else if (method === "GET" && path === `/api/v1/blogs/${blog.id}`) {
      body = blog;
    } else if (method === "GET" && path === `/api/v1/blogs/${blog.id}/posts/${post.id}`) {
      body = post;
    } else if (method === "PATCH" && path === `/api/v1/blogs/${blog.id}/posts/${post.id}`) {
      body = { ok: true };
    } else if (method === "GET" && path === `/api/v1/scripts/${script.id}`) {
      body = script;
    } else if (method === "GET" && path === `/api/v1/scripts/${script.id}/scenes/${scene.id}`) {
      body = scene;
    } else if (method === "PATCH" && path === `/api/v1/scripts/${script.id}/scenes/${scene.id}`) {
      body = { ok: true };
    } else {
      throw new Error(`Unhandled ${method} ${path}`);
    }

    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify(body),
    });
  });
}

const editors = [
  { kind: "blog", path: `/studio/blogs/${blog.id}/posts/${post.id}` },
  { kind: "script", path: `/studio/scripts/${script.id}/scenes/${scene.id}` },
] as const;

for (const editor of editors) {
  for (const colorScheme of ["light", "dark"] as const) {
    test(`empty ${editor.kind} editor fills its card in ${colorScheme} mode`, async ({ page }) => {
      await page.setViewportSize({ width: 390, height: 844 });
      await page.emulateMedia({ colorScheme });
      await mockEmptyEditors(page);
      await page.goto(editor.path);

      const shell = page.getByTestId("blocknote-editor-shell");
      const root = shell.locator(".bn-container");
      const editable = shell.locator('.bn-editor[contenteditable="true"]');

      await expect(editable).toBeVisible();
      await expect(root).toHaveCSS("background-color", "rgba(0, 0, 0, 0)");
      await expect(editable).toHaveCSS("background-color", "rgba(0, 0, 0, 0)");

      await expect
        .poll(() =>
          shell.evaluate((element) => {
            const shellRect = element.getBoundingClientRect();
            const editorRect = element.querySelector(".bn-editor")?.getBoundingClientRect();
            const paddingBottom = Number.parseFloat(getComputedStyle(element).paddingBottom);
            if (!editorRect) return Number.POSITIVE_INFINITY;
            return Math.abs(shellRect.bottom - paddingBottom - editorRect.bottom);
          }),
        )
        .toBeLessThanOrEqual(1);

      const clickPoint = await shell.evaluate((element) => {
        const rect = element.getBoundingClientRect();
        const paddingBottom = Number.parseFloat(getComputedStyle(element).paddingBottom);
        return { x: rect.left + rect.width / 2, y: rect.bottom - paddingBottom - 2 };
      });
      await page.mouse.click(clickPoint.x, clickPoint.y);
      await expect(editable).toBeFocused();
    });
  }
}
