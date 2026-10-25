import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { build } from "vite";
import { chromium, type Browser, type BrowserContext, type Locator } from "playwright";
import { afterAll, afterEach, beforeAll, beforeEach, expect, it } from "vitest";
import { startTestServer, type TestServer } from "@redline/server/test-harness";

const webRoot = fileURLToPath(new URL("..", import.meta.url));

let server: TestServer;
let browser: Browser;
let webDir: string;
let context: BrowserContext;

beforeAll(async () => {
  webDir = mkdtempSync(join(tmpdir(), "redline-web-"));
  await build({ root: webRoot, logLevel: "silent", build: { outDir: webDir, emptyOutDir: true } });
  server = await startTestServer({ webDir });
  browser = await chromium.launch();
  context = await browser.newContext({ viewport: { width: 1440, height: 900 }, permissions: ["clipboard-read", "clipboard-write"] });
  await context.tracing.start({ screenshots: true, snapshots: true });
}, 60_000);

// These journeys once timed out together under a full run and never again: record each test so a failure leaves a trace to open with `npx playwright show-trace`.
beforeEach(async () => {
  await context.tracing.startChunk();
});

afterEach(async ({ task }) => {
  if (task.result?.state === "fail") {
    const path = join(tmpdir(), `redline-trace-${task.name.slice(0, 40).replace(/\W+/g, "-")}-${Date.now()}.zip`);
    await context.tracing.stopChunk({ path });
    console.log(`Playwright trace of the failed journey: ${path}`);
  } else {
    await context.tracing.stopChunk();
  }
  // A failed journey leaves its tabs open: close them so the next journey starts alone in the context.
  await Promise.all(context.pages().map((page) => page.close()));
});

afterAll(async () => {
  await browser?.close();
  await server?.stop();
  rmSync(webDir, { recursive: true, force: true });
});

const html = `<!doctype html><body style="margin:0"><h1>Hi</h1></body>`;

async function createPage(files: Record<string, string>, manifest: object): Promise<string> {
  const project = (await (await server.post("/api/projects", { title: "Acme" })).json()) as { id: string };
  const page = (await server
    .post(`/api/projects/${project.id}/pages`, { title: "Flow", files: { ...files, "manifest.json": JSON.stringify(manifest) } })
    .then((res) => res.json())) as { id: string };
  return page.id;
}

async function box(locator: Locator) {
  const result = await locator.boundingBox();
  if (!result) throw new Error("element has no box");
  return result;
}

const withTweaks = {
  artboards: [
    { file: "home.html", title: "Home", width: 600, height: 300, x: 0, y: 0 },
    { file: "other.html", title: "Other", width: 600, height: 300, x: 800, y: 0 },
  ],
  tweaks: [
    { id: "dark", type: "toggle", label: "Dark", artboard: "home.html" },
    { id: "accent", type: "color", label: "Accent", artboard: "home.html" },
  ],
};

async function stripNames(strip: Locator): Promise<(string | null)[]> {
  return strip.getByRole("button").evaluateAll((buttons) => buttons.map((button) => button.getAttribute("aria-label")));
}

it("shows the same strip on every artboard: Tweaks · N only where tweaks apply, then comment, history, copy link, full screen and the ⋯ menu", async () => {
  const pageId = await createPage({ "home.html": html, "other.html": html }, withTweaks);
  const tab = await context.newPage();
  await tab.goto(`${server.url}/#/pages/${pageId}`);
  await tab.locator('[data-artboard="home.html"]').waitFor();

  expect(await stripNames(tab.locator('[data-strip="home.html"]'))).toEqual([
    "Tweaks · 2",
    "Commenter tout home.html",
    "Historique de home.html",
    "Copier le lien de home.html",
    "Lancer home.html en plein écran",
    "Autres actions pour home.html",
  ]);
  expect(await stripNames(tab.locator('[data-strip="other.html"]'))).toEqual([
    "Commenter tout other.html",
    "Historique de other.html",
    "Copier le lien de other.html",
    "Lancer other.html en plein écran",
    "Autres actions pour other.html",
  ]);

  const frame = await box(tab.locator('[data-artboard="home.html"] iframe'));
  const more = await box(tab.getByRole("button", { name: "Autres actions pour home.html" }));
  expect(Math.abs(more.x + more.width - (frame.x + frame.width))).toBeLessThan(2);
  await tab.close();
}, 60_000);

it("copies the full-screen address from the ⋯ menu", async () => {
  const pageId = await createPage({ "home.html": html, "other.html": html }, withTweaks);
  const tab = await context.newPage();
  await tab.goto(`${server.url}/#/pages/${pageId}`);

  expect(await tab.getByRole("button", { name: "Copier le lien plein écran de home.html" }).count()).toBe(0);
  await tab.getByRole("button", { name: "Autres actions pour home.html" }).click();
  const menu = tab.getByRole("menu", { name: "Autres actions pour home.html" });
  await menu.getByRole("menuitem", { name: "Copier le lien plein écran" }).click();
  await tab.getByRole("status").filter({ hasText: "Lien copié" }).waitFor();
  expect(await tab.evaluate(() => navigator.clipboard.readText())).toBe(`${server.url}/#/pages/${pageId}/play/home.html`);
  expect(await menu.count()).toBe(0);
  await tab.close();
}, 60_000);

it("spans a responsive frame's strip across the frame so its buttons end on the frame's right edge", async () => {
  const pageId = await createPage(
    { "landing.html": html },
    { artboards: [{ file: "landing.html", x: 0, y: 0, responsive: ["desktop", { format: "mobile", width: 390, height: 844 }] }] },
  );
  const tab = await context.newPage();
  await tab.goto(`${server.url}/#/pages/${pageId}`);
  const frame = await box(tab.locator("[data-responsive-frame]"));
  const more = await box(tab.getByRole("button", { name: "Autres actions pour landing.html" }));
  expect(Math.abs(more.x + more.width - (frame.x + frame.width))).toBeLessThan(2);
  await tab.close();
}, 60_000);

it("marks only component artboards with a ◆ and the component name on the strip", async () => {
  const pageId = await createPage(
    { "components/button.html": html, "home.html": html },
    {
      artboards: [
        { file: "components/button.html", title: "Primary button", width: 400, height: 200, x: 0, y: 0 },
        { file: "home.html", title: "Home", width: 400, height: 200, x: 600, y: 0 },
      ],
    },
  );
  const tab = await context.newPage();
  await tab.goto(`${server.url}/#/pages/${pageId}`);
  await tab.locator('[data-artboard="components/button.html"]').waitFor();

  const component = tab.locator('[data-strip="components/button.html"]');
  await component.getByRole("img", { name: "Composant" }).waitFor();
  expect(await component.getByTestId("component-name").textContent()).toBe("button");
  expect(await component.getByTestId("component-name").evaluate((el) => getComputedStyle(el).fontFamily)).toContain("JetBrains Mono");
  expect(await tab.locator('[data-strip="home.html"]').getByRole("img", { name: "Composant" }).count()).toBe(0);
  expect(await tab.locator('[data-strip="home.html"]').textContent()).toContain("Home");
  await tab.close();
}, 60_000);
