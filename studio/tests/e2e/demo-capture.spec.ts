import { isAbsolute, join } from "node:path";
import { type Page, expect, test } from "@playwright/test";
import {
  chapters,
  fullBook,
  project,
  publisherPack,
  renderJobs,
  sectionsByChapter,
} from "./demo-fixtures";

const CAPTURES = [
  ["/", "studio-home.png", /New book/],
  ["/compose#step-logline", "studio-compose.png", /Your story, in one sentence/],
  ["/demo-project/outline", "studio-outline.png", /3 chapters/],
  ["/demo-project/chapters/chapter-1", "studio-editor.png", /Chapter 1/],
  ["/demo-project/book", "studio-book.png", /The Cartographer's Lantern/],
  ["/demo-project#publish", "studio-publish.png", /Publisher pack/],
] as const;

test.use({
  viewport: { width: 1440, height: 1024 },
  colorScheme: "light",
  reducedMotion: "reduce",
});

const FIXED_NOW = 1_735_689_600_000;
const LOCAL_BASE_URL = "http://localhost:4190";
const LOCAL_ORIGIN = new URL(LOCAL_BASE_URL).origin;

test("captures deterministic Studio source screens", async ({ page }) => {
  if (process.env.E2E_BASE_URL !== LOCAL_BASE_URL) {
    throw new Error(`Demo capture must run against ${LOCAL_BASE_URL}`);
  }

  const captureDir = process.env.DEMO_CAPTURE_DIR;
  if (!captureDir || !isAbsolute(captureDir)) {
    throw new Error("DEMO_CAPTURE_DIR must be an absolute path");
  }

  const blockedExternalRequests: string[] = [];
  const unknownRequests: string[] = [];
  await page.route("**/*", async (route) => {
    const request = route.request();
    const url = new URL(request.url());
    if (url.pathname.startsWith("/api/v1/")) {
      await route.fallback();
      return;
    }
    if (url.origin === LOCAL_ORIGIN) {
      await route.continue();
      return;
    }
    blockedExternalRequests.push(`${request.method()} ${url.href}`);
    await route.abort("blockedbyclient");
  });

  await page.route("**/api/v1/**", async (route) => {
    const request = route.request();
    const pathname = new URL(request.url()).pathname;
    const response = knownResponse(request.method(), pathname);
    if (response === undefined) {
      const message = `Unmocked Studio API request: ${request.method()} ${pathname}`;
      unknownRequests.push(message);
      await route.abort("failed");
      throw new Error(message);
    }
    await route.fulfill({
      contentType: "application/json",
      body: JSON.stringify(response),
    });
  });

  await page.clock.install({ time: FIXED_NOW });

  for (const [route, filename, expected] of CAPTURES) {
    await page.goto(route);
    await page.addStyleTag({ content: "* { caret-color: transparent !important; }" });

    if (filename === "studio-compose.png") {
      await completeComposeToLogline(page);
    }

    if (filename === "studio-publish.png") {
      await openPublisherPack(page);
    }

    await expect(page.getByText(expected).first()).toBeVisible();
    await page.evaluate(() => document.fonts.ready);
    await expect.poll(() => page.evaluate(() => document.fonts.status)).toBe("loaded");
    await page.screenshot({ path: join(captureDir, filename), animations: "disabled" });
  }

  expect(blockedExternalRequests).toHaveLength(CAPTURES.length);
  for (const request of blockedExternalRequests) {
    expect(request).toMatch(/^GET https:\/\/fonts\.googleapis\.com\/css2\?/);
  }
  expect(unknownRequests).toEqual([]);
});

function knownResponse(method: string, pathname: string): unknown | undefined {
  if (method !== "GET") return undefined;

  const responses: Record<string, unknown> = {
    "/api/v1/projects": { items: [project] },
    "/api/v1/projects/deleted/recent": { items: [], retention_days: 30 },
    "/api/v1/blogs": { items: [] },
    "/api/v1/blogs/deleted/recent": { items: [], retention_days: 30 },
    "/api/v1/scripts": { items: [] },
    "/api/v1/scripts/deleted/recent": { items: [], retention_days: 30 },
    "/api/v1/projects/demo-project": project,
    "/api/v1/projects/demo-project/outline": { outline: null, chapters },
    "/api/v1/chapters/chapter-1": chapters[0],
    "/api/v1/chapters/chapter-1/sections": { items: sectionsByChapter["chapter-1"] },
    "/api/v1/chapters/chapter-2/sections": { items: sectionsByChapter["chapter-2"] },
    "/api/v1/chapters/chapter-3/sections": { items: sectionsByChapter["chapter-3"] },
    "/api/v1/projects/demo-project/book": {
      project: { id: project.id, title: project.title },
      book: fullBook,
      export_formats: ["epub", "pdf", "kpf"],
    },
    "/api/v1/projects/demo-project/publisher-pack": { pack: publisherPack },
    "/api/v1/projects/demo-project/export/jobs": { items: renderJobs },
    "/api/v1/projects/demo-project/narration/auditions": { items: [], approved: null },
    "/api/v1/projects/demo-project/audiobook/jobs": { items: [] },
    "/api/v1/scout/projects/demo-project/findings": { items: [] },
    "/api/v1/settings/elevenlabs-key": { configured: true },
    "/api/v1/account/elevenlabs-key": { configured: true },
    "/api/v1/session": {
      user: { id: "demo-user", name: "Demo Author", email: "demo@example.test", plan: "pro" },
    },
  };
  return responses[pathname];
}

async function completeComposeToLogline(page: Page) {
  const titleStep = page.locator("#step-title");
  await page.locator("#compose-title").fill(project.title);
  await titleStep.getByRole("button", { name: "Continue" }).click();

  const genreStep = page.locator("#step-genre");
  await expect(genreStep).toBeInViewport();
  await genreStep.getByRole("button", { name: "Fantasy", exact: true }).click();
  await genreStep.getByRole("button", { name: "Continue" }).click();

  const typeStep = page.locator("#step-type");
  await expect(typeStep).toBeInViewport();
  await typeStep.getByRole("button", { name: "Continue" }).click();

  const loglineStep = page.locator("#step-logline");
  await expect(loglineStep).toBeInViewport();
  await page.locator("#compose-logline").fill(project.logline ?? "");
}

async function openPublisherPack(page: Page) {
  await page.getByRole("link", { name: "Marketplace", exact: true }).click();
  await page.getByRole("button", { name: "Publish", exact: true }).click();
  const publisherPackSection = page.locator("#publish");
  await expect(publisherPackSection).toBeVisible();
  await publisherPackSection.scrollIntoViewIfNeeded();
}
