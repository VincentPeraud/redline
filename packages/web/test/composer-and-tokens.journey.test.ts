import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { build } from "vite";
import { chromium, type Browser } from "playwright";
import { afterAll, beforeAll, expect, it } from "vitest";
import { NEUTRAL_TOKENS_CSS, type DesignSystem, type Page, type Project } from "@redline/shared";
import { FakeEngine, startSeam2, type Seam2 } from "@redline/agent/seam2";

const webRoot = fileURLToPath(new URL("..", import.meta.url));

let browser: Browser;
let webDir: string;
let seam: Seam2;
const engine = new FakeEngine([{ type: "result", summary: "Nothing to change" }]);

beforeAll(async () => {
  webDir = mkdtempSync(join(tmpdir(), "redline-web-"));
  await build({ root: webRoot, logLevel: "silent", build: { outDir: webDir, emptyOutDir: true } });
  seam = await startSeam2(engine, { webDir });
  browser = await chromium.launch();
}, 60_000);

afterAll(async () => {
  await browser?.close();
  await seam?.stop();
  rmSync(webDir, { recursive: true, force: true });
});

it("lets the new comment choose the model and effort of the thread's first run", async () => {
  const page = await seam.createPage({ "home.html": "<!doctype html><h1>Title</h1>" });
  const tab = await browser.newPage({ viewport: { width: 1400, height: 900 } });
  await tab.goto(`${seam.server.url}/#/pages/${page.id}`);
  const artboard = tab.frameLocator("iframe");
  await expect.poll(() => artboard.locator("h1").textContent()).toBe("Title");

  await tab.keyboard.press("c");
  await artboard.locator("h1").click();
  await tab.locator("#new-comment").fill("Look at this");
  await tab.getByLabel("Modèle").selectOption("haiku");
  await tab.getByRole("radio", { name: "low" }).click();
  await tab.getByRole("button", { name: "Envoyer" }).click();

  await engine.finished(1);
  expect([engine.runs[0].model, engine.runs[0].effort]).toEqual(["haiku", "low"]);
  await tab.close();
}, 60_000);

it("reloads the open artboards when their design system gets a new version", async () => {
  // A project that follows a shared design system (its project style is empty, so the design system's values show).
  const designSystem = (await (await seam.server.post("/api/design-systems", { title: "Live", files: { "tokens.css": NEUTRAL_TOKENS_CSS, "index.html": "<h1>Live</h1>" } })).json()) as DesignSystem;
  const project = (await (await seam.server.post("/api/projects", { title: "Follower", designSystem: designSystem.id })).json()) as Project;
  const page = (await (
    await seam.server.post(`/api/projects/${project.id}/pages`, {
      title: "Tokens",
      files: {
        "tokens.html": '<!doctype html><h1 style="color: var(--color-primary)">Tokens</h1>',
        "manifest.json": JSON.stringify({ designSystem: designSystem.id, artboards: [{ file: "tokens.html" }] }),
      },
    })
  ).json()) as Page;
  const tab = await browser.newPage({ viewport: { width: 1400, height: 900 } });
  await tab.goto(`${seam.server.url}/#/pages/${page.id}`);
  const title = tab.frameLocator("iframe").locator("h1");
  const colour = () => title.evaluate((element) => getComputedStyle(element).color);
  await expect.poll(() => title.textContent()).toBe("Tokens");
  const before = await colour();

  const tokens = NEUTRAL_TOKENS_CSS.replace(/--color-primary:[^;]*;/, "--color-primary: #ff0000;");
  expect(tokens).not.toBe(NEUTRAL_TOKENS_CSS);
  const res = await seam.server.post(`/api/pages/${designSystem.pageId}/versions`, {
    files: { "tokens.css": tokens, "index.html": "<h1>Neutral</h1>" },
    message: "Red",
    origin: "thread",
  });
  expect(res.status).toBe(201);

  await expect.poll(colour).toBe("rgb(255, 0, 0)");
  expect(before).not.toBe("rgb(255, 0, 0)");
  await tab.close();
}, 60_000);
