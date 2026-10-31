import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { build } from "vite";
import { chromium, type Browser, type BrowserContext, type Page as Tab } from "playwright";
import { afterAll, afterEach, beforeAll, expect, it } from "vitest";
import { MANIFEST_PATH } from "@redline/shared";
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
  context = await browser.newContext({ viewport: { width: 1440, height: 900 } });
}, 60_000);

afterEach(async () => {
  await Promise.all(context.pages().map((page) => page.close()));
});

afterAll(async () => {
  await browser?.close();
  await server?.stop();
  rmSync(webDir, { recursive: true, force: true });
});

/** A project with a page holding no artboard, only canvas elements spread far apart, and a page with one artboard. */
async function createProject() {
  const project = (await (await server.post("/api/projects", { title: "Hispanos" })).json()) as { id: string };
  const references = (await (
    await server.post(`/api/projects/${project.id}/pages`, {
      title: "Références",
      files: {
        [MANIFEST_PATH]: JSON.stringify({
          artboards: [],
          elements: [
            { kind: "title", id: "t", text: "Point de départ", x: 0, y: 0 },
            { kind: "sticky", id: "s", text: "Note tout en bas", x: 0, y: 3000 },
            { kind: "shape", id: "r", shape: "rect", x: 2400, y: 1500, width: 400, height: 300 },
          ],
        }),
      },
    })
  ).json()) as { id: string };
  await server.post(`/api/projects/${project.id}/pages`, {
    title: "Accueil",
    files: {
      "home.html": "<!doctype html><body style='margin:0'><h1>Accueil</h1></body>",
      [MANIFEST_PATH]: JSON.stringify({ artboards: [{ file: "home.html", title: "Accueil", x: 0, y: 0, width: 1440, height: 900 }] }),
    },
  });
  return { projectId: project.id, referencesId: references.id };
}

const zoomOf = async (tab: Tab) => Number((await tab.getByText(/^\d+ %$/).textContent())!.replace(/\D/g, ""));

it("fits the whole canvas with Tout voir, and shows it in a mini-map that moves the view and hides with M", async () => {
  const { referencesId } = await createProject();
  const tab = await context.newPage();
  await tab.goto(`${server.url}/#/pages/${referencesId}`);
  const map = tab.getByTestId("overview-map");
  await map.waitFor();
  await expect.poll(() => map.locator('[data-testid="overview-viewport"]').count()).toBe(1);
  expect(await map.getByText("Note tout en bas").count()).toBe(1);

  // At 100 %, the sticky 3000 px below is out of sight; Tout voir brings everything in.
  expect(await zoomOf(tab)).toBe(100);
  await tab.getByRole("button", { name: "Tout voir (F)" }).click();
  await expect.poll(() => zoomOf(tab)).toBeLessThan(30);
  await tab.waitForTimeout(600); // the end of the glide
  const sticky = (await tab.getByTestId("canvas").getByText("Note tout en bas").boundingBox())!;
  const stage = (await tab.getByTestId("canvas").boundingBox())!;
  expect(sticky.y + sticky.height).toBeLessThan(stage.y + stage.height);

  // A click on the mini-map centres that place, at the same zoom.
  const zoom = await zoomOf(tab);
  const before = (await map.getByTestId("overview-viewport").boundingBox())!;
  const area = (await map.locator("> div").nth(1).boundingBox())!;
  await tab.mouse.click(area.x + 20, area.y + area.height - 20);
  await expect.poll(async () => (await map.getByTestId("overview-viewport").boundingBox())!.y).toBeGreaterThan(before.y);
  expect(await zoomOf(tab)).toBe(zoom);

  // M hides it, the choice survives a reload, and the button brings it back.
  await tab.getByTestId("canvas").click({ position: { x: 600, y: 400 } });
  await tab.keyboard.press("m");
  await tab.getByTestId("overview-show").waitFor();
  expect(await map.count()).toBe(0);
  await tab.reload();
  await tab.getByTestId("overview-show").click();
  await map.waitFor();

  // F fits again from the keyboard.
  await tab.getByRole("button", { name: "Zoomer", exact: true }).click();
  const zoomedIn = await zoomOf(tab);
  await tab.keyboard.press("f");
  await expect.poll(() => zoomOf(tab)).toBeLessThan(zoomedIn);
  await tab.waitForTimeout(600);
  expect(await zoomOf(tab)).toBe(zoom);
});

it("shows the canvas photo in the page cards, for a page with no artboard too", async () => {
  const { projectId } = await createProject();
  const tab = await context.newPage();
  await tab.goto(`${server.url}/#/projects/${projectId}`);
  const references = tab.getByTestId("page-card").filter({ hasText: "Références" });
  const home = tab.getByTestId("page-card").filter({ hasText: "Accueil" });
  await expect.poll(() => references.getByText("Point de départ").count()).toBe(1);
  await expect.poll(() => home.locator('[data-photo-artboard="home.html"] iframe').count()).toBe(1);

  // The Références canvas is tall: the card shows its top, cropped; the sticky at the bottom is out of the card.
  const card = (await references.boundingBox())!;
  const title = (await references.getByText("Point de départ").boundingBox())!;
  const sticky = (await references.getByText("Note tout en bas").boundingBox())!;
  expect(title.y).toBeGreaterThan(card.y);
  expect(sticky.y).toBeGreaterThan(card.y + 150);
});
