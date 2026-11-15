import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { copyBuiltWeb } from "./builtWeb.js";
import { type Browser, type BrowserContext, type Locator } from "playwright";
import { launchBrowser } from "./journeyBrowser.js";
import { afterAll, afterEach, beforeAll, beforeEach, expect, it } from "vitest";
import { startTestServer, type TestServer } from "@redline/server/test-harness";

let server: TestServer;
let browser: Browser;
let webDir: string;
let context: BrowserContext;

beforeAll(async () => {
  webDir = mkdtempSync(join(tmpdir(), "redline-web-"));
  copyBuiltWeb(webDir);
  server = await startTestServer({ webDir });
  browser = await launchBrowser();
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

const farApart = {
  artboards: [
    { file: "near.html", title: "Near", width: 400, height: 300, x: 0, y: 0 },
    { file: "far away.html", title: "Far", width: 400, height: 300, x: 3000, y: 1500 },
  ],
};

it("opens an artboard address centred on the artboard, outlines it once, and leaves the URL alone while panning and zooming", async () => {
  const pageId = await createPage({ "near.html": html, "far away.html": html }, farApart);
  const tab = await context.newPage();
  await tab.goto(`${server.url}/#/pages/${pageId}/artboards/${encodeURIComponent("far away.html")}`);

  const artboard = tab.locator('[data-artboard="far away.html"]');
  await artboard.waitFor();
  const viewport = await box(tab.getByTestId("canvas"));
  const frame = await box(artboard.locator("iframe"));
  expect(Math.abs(frame.x + frame.width / 2 - (viewport.x + viewport.width / 2))).toBeLessThan(3);
  expect(Math.abs(frame.y + frame.height / 2 - (viewport.y + viewport.height / 2))).toBeLessThan(3);

  await tab.locator("[data-artboard-outline]").waitFor();
  expect(await tab.locator("[data-artboard-outline]").count()).toBe(1);
  expect(await artboard.locator("[data-artboard-outline]").count()).toBe(1);
  await tab.locator("[data-artboard-outline]").waitFor({ state: "detached" });

  const hash = await tab.evaluate(() => window.location.hash);
  await tab.mouse.move(viewport.x + 300, viewport.y + 300);
  await tab.mouse.wheel(120, 80);
  await tab.keyboard.down("Control");
  await tab.mouse.wheel(0, -200);
  await tab.keyboard.up("Control");
  await tab.getByRole("button", { name: "Zoomer", exact: true }).click();
  expect(await tab.evaluate(() => window.location.hash)).toBe(hash);
  expect(await tab.locator("[data-artboard-outline]").count()).toBe(0);
  await tab.close();
}, 60_000);

it("opens the canvas with a dismissable message when the address names an artboard that is gone", async () => {
  const pageId = await createPage({ "near.html": html, "far away.html": html }, farApart);
  const tab = await context.newPage();
  await tab.goto(`${server.url}/#/pages/${pageId}/artboards/old-cart.html`);

  const message = tab.getByRole("status").filter({ hasText: "Cet artboard n'existe plus" });
  await message.waitFor();
  expect(await message.innerText()).toContain("Cet artboard n'existe plus · old-cart.html");
  expect(await tab.locator('[data-artboard="near.html"]').count()).toBe(1);
  expect(await tab.locator("[data-artboard-outline]").count()).toBe(0);

  await message.getByRole("button", { name: "Fermer" }).click();
  expect(await message.count()).toBe(0);
  expect(await tab.evaluate(() => window.location.hash)).toBe(`#/pages/${pageId}/artboards/old-cart.html`);
  await tab.close();
}, 60_000);

it("drops the message when the route moves to an address that exists", async () => {
  const pageId = await createPage({ "near.html": html, "far away.html": html }, farApart);
  const tab = await context.newPage();
  await tab.goto(`${server.url}/#/pages/${pageId}/artboards/old-cart.html`);
  const message = tab.getByRole("status").filter({ hasText: "Cet artboard n'existe plus" });
  await message.waitFor();

  await tab.evaluate((id) => (window.location.hash = `#/pages/${id}/artboards/near.html`), pageId);
  await message.waitFor({ state: "detached" });
  await tab.close();
}, 60_000);

it("copies the full canvas address of an artboard from its name strip and confirms with a short Lien copié bubble", async () => {
  const pageId = await createPage({ "near.html": html, "far away.html": html }, farApart);
  const tab = await context.newPage();
  await tab.goto(`${server.url}/#/pages/${pageId}`);

  await tab.getByRole("button", { name: "Copier le lien de far away.html" }).click();
  const bubble = tab.getByRole("status").filter({ hasText: "Lien copié" });
  await bubble.waitFor();
  expect(await tab.evaluate(() => navigator.clipboard.readText())).toBe(`${server.url}/#/pages/${pageId}/artboards/far%20away.html`);
  await bubble.waitFor({ state: "detached", timeout: 4000 });

  // the copied address opens the artboard
  const other = await context.newPage();
  await other.goto(await tab.evaluate(() => navigator.clipboard.readText()));
  await other.locator("[data-artboard-outline]").waitFor();
  await other.close();
  await tab.close();
}, 60_000);

it("shows a link card aimed at an artboard of another page, opens it centred, and says when the artboard is gone", async () => {
  const targetId = await createPage({ "near.html": html, "far away.html": html }, farApart);
  const sourceId = await createPage(
    { "home.html": html },
    {
      artboards: [{ file: "home.html", x: 0, y: 0 }],
      elements: [
        { kind: "link", id: "carte", page: targetId, file: "far away.html", x: 0, y: 500 },
        { kind: "link", id: "perdue", page: targetId, file: "old-cart.html", x: 0, y: 700 },
      ],
    },
  );
  const tab = await context.newPage();
  await tab.goto(`${server.url}/#/pages/${sourceId}`);

  const card = tab.locator('[data-canvas-element-id="carte"]');
  await card.getByText("Far", { exact: true }).waitFor();
  expect(await card.innerText()).toContain("Artboard · Flow · Acme");
  const gone = tab.locator('[data-canvas-element-id="perdue"]');
  await gone.getByText("Artboard introuvable").waitFor();

  await card.click();
  const artboard = tab.locator('[data-artboard="far away.html"]');
  await artboard.waitFor();
  expect(await tab.evaluate(() => window.location.hash)).toBe(`#/pages/${targetId}/artboards/far%20away.html`);
  const viewport = await box(tab.getByTestId("canvas"));
  const frame = await box(artboard.locator("iframe"));
  expect(Math.abs(frame.x + frame.width / 2 - (viewport.x + viewport.width / 2))).toBeLessThan(3);
  await tab.close();
}, 60_000);

it("puts the copy link button once on a responsive frame", async () => {
  const pageId = await createPage(
    { "landing.html": html },
    { artboards: [{ file: "landing.html", x: 0, y: 0, responsive: ["desktop", { format: "mobile", width: 390, height: 844 }] }] },
  );
  const tab = await context.newPage();
  await tab.goto(`${server.url}/#/pages/${pageId}`);
  await tab.locator("[data-responsive-frame]").waitFor();
  expect(await tab.getByRole("button", { name: "Copier le lien de landing.html" }).count()).toBe(1);
  await tab.close();
}, 60_000);
