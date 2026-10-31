import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { build } from "vite";
import { type Browser } from "playwright";
import { launchBrowser } from "./journeyBrowser.js";
import { afterAll, beforeAll, expect, it } from "vitest";
import type { Page } from "@redline/shared";
import { startTestServer, type TestServer } from "@redline/server/test-harness";

const webRoot = fileURLToPath(new URL("..", import.meta.url));

let server: TestServer;
let browser: Browser;
let webDir: string;

beforeAll(async () => {
  webDir = mkdtempSync(join(tmpdir(), "redline-web-"));
  await build({ root: webRoot, logLevel: "silent", build: { outDir: webDir, emptyOutDir: true } });
  server = await startTestServer({ webDir });
  browser = await launchBrowser();
}, 60_000);

afterAll(async () => {
  await browser?.close();
  await server?.stop();
  rmSync(webDir, { recursive: true, force: true });
});

const BUTTON = `<!doctype html><html><body style="margin:0"><button>Réserver</button></body></html>`;

it("draws a tweak grid as one frame: labelled blocks, columns and rows, one cell per combination rendering the same file, one strip spanning the frame, and the other tweaks reach every cell", async () => {
  const project = (await (await server.post("/api/projects", { title: "Grid" })).json()) as { id: string };
  const page = (await (
    await server.post(`/api/projects/${project.id}/pages`, {
      title: "Buttons",
      files: {
        "btn.html": BUTTON,
        "manifest.json": JSON.stringify({
          artboards: [{ file: "btn.html", x: 0, y: 0, width: 160, height: 50, matrix: { rows: "state", columns: "variant", blocks: "icon" } }],
          tweaks: [
            { id: "state", type: "choice", label: "État", options: ["Default", "Hover", "Disabled"] },
            { id: "variant", type: "choice", label: "Variante", options: ["Contained", "Outlined"] },
            { id: "icon", type: "toggle", label: "Icône" },
            { id: "label", type: "text", label: "Texte", default: "Réserver" },
          ],
        }),
      },
    })
  ).json()) as Page;

  const tab = await browser.newPage({ viewport: { width: 1440, height: 900 } });
  await tab.goto(`${server.url}/#/pages/${page.id}`);

  const cells = tab.locator("[data-grid-cell] iframe");
  await cells.nth(11).waitFor();
  expect(await cells.count()).toBe(12);

  expect(await tab.locator("[data-grid-block]").allTextContents()).toEqual(["Icône : non", "Icône : oui"]);
  expect(await tab.locator("[data-grid-column]").allTextContents()).toEqual(["Contained", "Outlined", "Contained", "Outlined"]);
  expect(await tab.locator("[data-grid-row]").allTextContents()).toEqual(["Default", "Hover", "Disabled", "Default", "Hover", "Disabled"]);

  const frame = tab.locator("[data-tweak-grid]");
  expect(await frame.evaluate((el) => [(el as HTMLElement).offsetWidth, (el as HTMLElement).offsetHeight])).toEqual([2 + 48 + 96 + 320, 2 + 40 + 2 * 202 + 22]);

  const combination = (index: number) =>
    cells.nth(index).contentFrame().locator("html").evaluate((el) => [el.dataset.tweakState, el.dataset.tweakVariant, el.dataset.tweakIcon]);
  await expect.poll(() => combination(0)).toEqual(["Default", "Contained", "false"]);
  await expect.poll(() => combination(3)).toEqual(["Hover", "Outlined", "false"]);
  await expect.poll(() => combination(11)).toEqual(["Disabled", "Outlined", "true"]);

  // one strip, as wide as the frame and aligned on it
  expect(await tab.locator("[data-strip]").count()).toBe(1);
  expect(await tab.getByText("grille · état × variante × icône").count()).toBe(1);
  const strip = await tab.locator("[data-strip]").boundingBox();
  const box = await frame.boundingBox();
  expect(Math.abs(strip!.x - box!.x)).toBeLessThan(1);
  expect(Math.abs(strip!.width - box!.width)).toBeLessThan(1);

  // a tweak that is not a grid dimension reaches every cell
  await tab.getByRole("button", { name: "Tweaks · 4" }).click();
  await tab.getByRole("textbox", { name: /Texte/ }).fill("Acheter");
  for (const index of [0, 5, 11]) {
    await expect.poll(() => cells.nth(index).contentFrame().locator("html").getAttribute("data-tweak-label")).toBe("Acheter");
  }
  expect(await combination(5)).toEqual(["Disabled", "Outlined", "false"]);
}, 60_000);

it("pins a comment in one cell: its pin stays in that cell after a reload, the comments panel names the cell's values, and play mode shows the artboard once with its Tweaks panel", async () => {
  const project = (await (await server.post("/api/projects", { title: "Grid pins" })).json()) as { id: string };
  const page = (await (
    await server.post(`/api/projects/${project.id}/pages`, {
      title: "Buttons",
      files: {
        "btn.html": BUTTON,
        "manifest.json": JSON.stringify({
          artboards: [{ file: "btn.html", x: 0, y: 0, width: 160, height: 50, matrix: { rows: "state", columns: "variant", blocks: "icon" } }],
          tweaks: [
            { id: "state", type: "choice", label: "État", options: ["Default", "Hover", "Disabled"] },
            { id: "variant", type: "choice", label: "Variante", options: ["Contained", "Outlined"] },
            { id: "icon", type: "toggle", label: "Icône" },
          ],
        }),
      },
    })
  ).json()) as Page;

  const tab = await browser.newPage({ viewport: { width: 1440, height: 900 } });
  await tab.goto(`${server.url}/#/pages/${page.id}`);
  const cell = (key: string) => tab.locator(`[data-grid-cell="${key}"]`);
  await cell("0-1-1").locator("iframe").waitFor();
  await expect.poll(() => cell("0-1-1").locator("iframe").contentFrame().locator("button").count()).toBe(1);

  await tab.keyboard.press("c");
  await cell("0-1-1").locator("iframe").contentFrame().locator("button").click();
  await tab.locator("#new-comment").fill("Outline too thin");
  await tab.locator("#new-comment").press("Enter");

  const pinsIn = (key: string) => cell(key).locator("[data-pin]").count();
  await expect.poll(() => pinsIn("0-1-1")).toBe(1);
  expect(await pinsIn("0-0-0")).toBe(0);
  await tab.getByRole("tab", { name: /Commentaires/ }).click();
  expect(await tab.getByTestId("thread-cell").allTextContents()).toEqual(["vu en Hover · Outlined · Icône : non"]);

  await tab.reload();
  await expect.poll(() => pinsIn("0-1-1")).toBe(1);
  expect(await tab.locator("[data-pin]").count()).toBe(1);
  const [thread] = (await (await server.get(`/api/pages/${page.id}/threads`)).json()) as { cell: unknown }[];
  expect(thread.cell).toEqual({ state: "Hover", variant: "Outlined", icon: false });

  // play mode ignores the grid: the artboard once, with its Tweaks panel
  await tab.goto(`${server.url}/#/pages/${page.id}/play/btn.html`);
  const play = tab.getByTestId("play");
  await play.locator("iframe").waitFor();
  expect(await play.locator("iframe").count()).toBe(1);
  expect(await tab.locator("[data-tweak-grid]").count()).toBe(0);
  expect(await play.getByRole("complementary", { name: "Tweaks" }).count()).toBe(1);
}, 60_000);
