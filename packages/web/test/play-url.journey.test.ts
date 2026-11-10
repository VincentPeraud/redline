import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { build } from "vite";
import { type Browser, type BrowserContext, type Page } from "playwright";
import { launchBrowser } from "./journeyBrowser.js";
import { afterAll, beforeAll, expect, it } from "vitest";
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
  browser = await launchBrowser();
  context = await browser.newContext({ viewport: { width: 1440, height: 900 }, permissions: ["clipboard-read", "clipboard-write"] });
}, 60_000);

afterAll(async () => {
  await browser?.close();
  await server?.stop();
  rmSync(webDir, { recursive: true, force: true });
});

const html = `<!doctype html><body style="margin:0"><h1>Hi</h1></body>`;

async function createPage(manifest: object): Promise<string> {
  const project = (await (await server.post("/api/projects", { title: "Acme" })).json()) as { id: string };
  const page = (await server
    .post(`/api/projects/${project.id}/pages`, {
      title: "Flow",
      files: { "one.html": html, "two.html": html, "landing.html": html, "manifest.json": JSON.stringify(manifest) },
    })
    .then((res) => res.json())) as { id: string };
  return page.id;
}

const plain = {
  artboards: [
    { file: "one.html", title: "One", width: 400, height: 300, x: 0, y: 0 },
    { file: "two.html", title: "Two", width: 400, height: 300, x: 600, y: 0 },
  ],
};

const responsive = {
  artboards: [
    { file: "landing.html", x: 0, y: 0, responsive: ["desktop", "tablet", { format: "mobile", width: 414, height: 896 }] },
    { file: "one.html", x: 5000, y: 0, width: 400, height: 300 },
  ],
};

const hashOf = (tab: Page) => tab.evaluate(() => window.location.hash);
const frameOf = (tab: Page) => tab.getByTestId("play").locator("main");

it("enters play from the name strip by pushing the play route, and Back or Échap return to the canvas", async () => {
  const pageId = await createPage(plain);
  const tab = await context.newPage();
  await tab.goto(`${server.url}/#/pages/${pageId}`);
  await tab.getByRole("button", { name: "Lancer two.html en plein écran" }).click();
  await tab.getByTestId("play").waitFor();
  expect(await hashOf(tab)).toBe(`#/pages/${pageId}/play/two.html`);
  expect(await tab.getByTestId("play").locator("iframe").getAttribute("title")).toMatch(/two\.html$/);

  await tab.goBack();
  await tab.getByTestId("canvas").waitFor();
  expect(await tab.getByTestId("play").count()).toBe(0);

  await tab.goForward();
  await tab.getByTestId("play").waitFor();
  await tab.keyboard.press("Escape");
  await tab.getByTestId("canvas").waitFor();
  expect(await hashOf(tab)).toBe(`#/pages/${pageId}`);
  await tab.close();
}, 60_000);

it("reopens the artboard of a play URL on reload, and follows the artboard buttons in the URL without adding history entries", async () => {
  const pageId = await createPage(plain);
  const tab = await context.newPage();
  await tab.goto(`${server.url}/#/pages/${pageId}/play/two.html`);
  const play = tab.getByTestId("play");
  await play.waitFor();
  expect(await play.locator("iframe").getAttribute("title")).toMatch(/two\.html$/);

  await play.getByRole("button", { name: "Artboard précédent (←)" }).click();
  await expect.poll(() => hashOf(tab)).toBe(`#/pages/${pageId}/play/one.html`);
  await tab.reload();
  await play.waitFor();
  expect(await play.locator("iframe").getAttribute("title")).toMatch(/one\.html$/);

  const before = await tab.evaluate(() => window.history.length);
  await play.getByRole("button", { name: "Artboard suivant (→)" }).click();
  await expect.poll(() => hashOf(tab)).toBe(`#/pages/${pageId}/play/two.html`);
  expect(await tab.evaluate(() => window.history.length)).toBe(before);
  await tab.close();
}, 60_000);

it("reads rendu as a key, a bare format, aucun, an unknown value, or falls back to the remembered rendering", async () => {
  const pageId = await createPage(responsive);
  const play = `${server.url}/#/pages/${pageId}/play/landing.html`;
  const tab = await context.newPage();
  const shown = async () => {
    await tab.getByTestId("play").waitFor();
    return frameOf(tab).getAttribute("data-frame");
  };

  await tab.goto(`${play}?rendu=mobile-414`);
  expect(await shown()).toBe("phone");
  await tab.goto(`${play}?rendu=tablet`);
  await tab.reload();
  expect(await shown()).toBe("tablet");
  await tab.goto(`${play}?rendu=aucun`);
  await tab.reload();
  expect(await shown()).toBe("none");
  await tab.goto(`${play}?rendu=watch-12`);
  await tab.reload();
  expect(await shown()).toBe("browser");

  // no rendu: the remembered choice applies
  await tab.goto(play);
  await tab.reload();
  await tab.getByTestId("play").getByRole("group", { name: "Rendu responsive" }).getByRole("button", { name: "Mobile" }).click();
  await tab.goto(play);
  await tab.reload();
  expect(await shown()).toBe("phone");
  await tab.close();
}, 60_000);

it("keeps rendu up to date from the rendering selector without adding history entries", async () => {
  const pageId = await createPage(responsive);
  const tab = await context.newPage();
  await tab.goto(`${server.url}/#/pages/${pageId}/play/landing.html?rendu=tablet-768`);
  const selector = tab.getByTestId("play").getByRole("group", { name: "Rendu responsive" });
  await selector.waitFor();
  const before = await tab.evaluate(() => window.history.length);

  await selector.getByRole("button", { name: "Mobile" }).click();
  await expect.poll(() => hashOf(tab)).toBe(`#/pages/${pageId}/play/landing.html?rendu=mobile-414`);
  await selector.getByRole("button", { name: "Aucun" }).click();
  await expect.poll(() => hashOf(tab)).toBe(`#/pages/${pageId}/play/landing.html?rendu=aucun`);
  expect(await tab.evaluate(() => window.history.length)).toBe(before);

  await tab.reload();
  await selector.waitFor();
  expect(await selector.getByRole("button", { name: "Aucun" }).getAttribute("aria-pressed")).toBe("true");
  await tab.close();
}, 60_000);

it("opens the canvas with the message when a play address names an artboard that is gone", async () => {
  const pageId = await createPage(plain);
  const tab = await context.newPage();
  await tab.goto(`${server.url}/#/pages/${pageId}/play/old-cart.html`);
  const message = tab.getByRole("status").filter({ hasText: "Cet artboard n'existe plus" });
  await message.waitFor();
  expect(await message.innerText()).toContain("Cet artboard n'existe plus · old-cart.html");
  expect(await tab.getByTestId("play").count()).toBe(0);
  expect(await tab.locator('[data-artboard="one.html"]').count()).toBe(1);
  await tab.close();
}, 60_000);

it("drops the gone-artboard message when the route moves to a play address that exists", async () => {
  const pageId = await createPage(plain);
  const tab = await context.newPage();
  await tab.goto(`${server.url}/#/pages/${pageId}/play/old-cart.html`);
  const message = tab.getByRole("status").filter({ hasText: "Cet artboard n'existe plus" });
  await message.waitFor();

  await tab.evaluate((id) => (window.location.hash = `#/pages/${id}/play/one.html`), pageId);
  await tab.getByTestId("play").waitFor();
  await tab.keyboard.press("Escape");
  await tab.locator('[data-artboard="one.html"]').waitFor();
  expect(await message.count()).toBe(0);
  await tab.close();
}, 60_000);

it("copies the full-screen address from the name strip and the current play URL, rendu included, from the play header", async () => {
  const pageId = await createPage(responsive);
  const tab = await context.newPage();
  await tab.goto(`${server.url}/#/pages/${pageId}`);

  await tab.getByRole("button", { name: "Autres actions pour landing.html" }).click();
  await tab.getByRole("menuitem", { name: "Copier le lien plein écran" }).click();
  const bubble = tab.getByRole("status").filter({ hasText: "Lien copié" });
  await bubble.waitFor();
  expect(await tab.evaluate(() => navigator.clipboard.readText())).toBe(`${server.url}/#/pages/${pageId}/play/landing.html`);
  await bubble.waitFor({ state: "detached", timeout: 4000 });

  await tab.getByRole("button", { name: "Lancer landing.html en plein écran" }).click();
  const play = tab.getByTestId("play");
  await play.getByRole("group", { name: "Rendu responsive" }).getByRole("button", { name: "Mobile" }).click();
  await play.getByRole("button", { name: "Copier le lien", exact: true }).click();
  await play.getByRole("status").filter({ hasText: "Lien copié" }).waitFor();
  expect(await tab.evaluate(() => navigator.clipboard.readText())).toBe(`${server.url}/#/pages/${pageId}/play/landing.html?rendu=mobile-414`);
  await play.getByRole("status").filter({ hasText: "Lien copié" }).waitFor({ state: "detached", timeout: 4000 });
  await tab.close();
}, 60_000);
