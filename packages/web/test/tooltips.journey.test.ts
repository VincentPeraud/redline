import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { copyBuiltWeb } from "./builtWeb.js";
import { type Browser, type Page } from "playwright";
import { launchBrowser } from "./journeyBrowser.js";
import { afterAll, beforeAll, expect, it } from "vitest";
import { startTestServer, type TestServer } from "@redline/server/test-harness";

let server: TestServer;
let browser: Browser;
let webDir: string;

beforeAll(async () => {
  webDir = mkdtempSync(join(tmpdir(), "redline-web-"));
  copyBuiltWeb(webDir);
  server = await startTestServer({ webDir });
  browser = await launchBrowser();
}, 60_000);

afterAll(async () => {
  await browser?.close();
  await server?.stop();
  rmSync(webDir, { recursive: true, force: true });
});

async function createPage(): Promise<string> {
  const project = (await (await server.post("/api/projects", { title: "Tips" })).json()) as { id: string };
  const page = (await server
    .post(`/api/projects/${project.id}/pages`, {
      title: "Tips",
      files: {
        "a.html": "<!doctype html><h1>A</h1>",
        "b.html": "<!doctype html><h1>B</h1>",
        "manifest.json": JSON.stringify({ artboards: [{ file: "a.html", width: 600, height: 400, x: 0, y: 0 }, { file: "b.html", width: 600, height: 400, x: 800, y: 0 }] }),
      },
    })
    .then((res) => res.json())) as { id: string };
  return page.id;
}

const nativeTitlesOnIconButtons = (tab: Page) =>
  tab.evaluate(() => [...document.querySelectorAll("button[title]")].filter((button) => (button.textContent ?? "").trim() === "").map((button) => button.getAttribute("title")));

it("shows a styled tooltip on hover, hides it on leave, and shows it on keyboard focus", async () => {
  const pageId = await createPage();
  const tab = await browser.newPage({ viewport: { width: 1440, height: 900 } });
  await tab.goto(`${server.url}/#/pages/${pageId}`);
  const zoomIn = tab.getByRole("button", { name: "Zoomer", exact: true });
  const tooltip = tab.getByRole("tooltip");

  await zoomIn.hover();
  await tooltip.waitFor();
  expect(await tooltip.textContent()).toBe("Zoomer");
  expect(await tooltip.evaluate((el) => getComputedStyle(el).backgroundColor)).toBe("rgb(24, 24, 27)");

  await tab.mouse.move(700, 450);
  await expect.poll(() => tooltip.count()).toBe(0);

  for (let i = 0; i < 40 && (await tab.evaluate(() => document.activeElement?.getAttribute("aria-label"))) !== "Dézoomer"; i++) await tab.keyboard.press("Tab");
  await tooltip.waitFor();
  expect(await tooltip.textContent()).toBe("Dézoomer");
  await tab.keyboard.press("Tab");
  await expect.poll(async () => await tooltip.allTextContents()).toEqual(["Zoomer"]);
  await tab.keyboard.press("Shift+Tab");
  await tab.keyboard.press("Shift+Tab");
  await expect.poll(async () => (await tooltip.allTextContents()).includes("Zoomer")).toBe(false);
});

it("keeps no native title tooltip on icon-only buttons, on the canvas and in play mode", async () => {
  const pageId = await createPage();
  const tab = await browser.newPage({ viewport: { width: 1440, height: 900 } });
  await tab.goto(`${server.url}/#/pages/${pageId}`);
  await tab.getByRole("button", { name: "Lancer a.html en plein écran" }).waitFor();
  expect(await nativeTitlesOnIconButtons(tab)).toEqual([]);

  await tab.getByRole("button", { name: "Lancer a.html en plein écran" }).click();
  await tab.getByTestId("play").waitFor();
  expect(await nativeTitlesOnIconButtons(tab)).toEqual([]);
  const next = tab.getByRole("button", { name: "Artboard suivant (→)" });
  await next.hover();
  await tab.getByRole("tooltip").waitFor();
  expect(await tab.getByRole("tooltip").textContent()).toContain("Artboard suivant");
});
