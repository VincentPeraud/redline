import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { build } from "vite";
import { chromium, type Browser } from "playwright";
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
  browser = await chromium.launch();
}, 60_000);

afterAll(async () => {
  await browser?.close();
  await server?.stop();
  rmSync(webDir, { recursive: true, force: true });
});

it("draws arrows between artboards, notes and free points, with label, colour and dashed line, on the nearest edges of the measured boxes", async () => {
  const project = (await (await server.post("/api/projects", { title: "Arrows" })).json()) as { id: string };
  const page = (await (
    await server.post(`/api/projects/${project.id}/pages`, {
      title: "Arrows",
      files: {
        "a.html": "<!doctype html><body>A</body>",
        "b.html": "<!doctype html><body>B</body>",
        "manifest.json": JSON.stringify({
          artboards: [
            { file: "a.html", width: 400, height: 300, x: 0, y: 0 },
            { file: "b.html", width: 400, height: 300, x: 800, y: 0 },
          ],
          elements: [
            { kind: "sticky", id: "question", text: "Fixed bottom button or in the flow?", color: "pink", x: 800, y: 500 },
            { kind: "arrow", from: "a.html", to: "b.html", label: "Continuer" },
            { kind: "arrow", from: "b.html", to: "question", label: "après choix", color: "blue", line: "dashed" },
            { kind: "arrow", from: "question", to: { x: 1500, y: 700 } },
          ],
        }),
      },
    })
  ).json()) as Page;

  const tab = await browser.newPage({ viewport: { width: 1400, height: 900 } });
  await tab.goto(`${server.url}/#/pages/${page.id}`);
  await tab.locator("[data-canvas-sticky]").waitFor();
  const paths = tab.locator("[data-canvas-arrow] > path");
  await paths.nth(2).waitFor();
  const sticky = await tab.locator("[data-canvas-sticky]").evaluate((el) => ({ w: (el as HTMLElement).offsetWidth, h: (el as HTMLElement).offsetHeight }));

  expect(await paths.nth(0).getAttribute("d")).toBe("M400 150 L800 150");
  // not aligned: a soft curve, from the bottom of the artboard to the top of the sticky
  expect(await paths.nth(1).getAttribute("d")).toMatch(/^M1000 300 C[\d. ]+ 920 500$/);
  // the sticky's height is measured from the DOM: the arrow leaves its right edge at mid height
  expect(await paths.nth(2).getAttribute("d")).toMatch(new RegExp(`^M${800 + sticky.w} ${500 + sticky.h / 2} C[\\d. ]+ 1500 700$`));

  expect(await paths.nth(0).getAttribute("stroke-dasharray")).toBeNull();
  expect(await paths.nth(1).getAttribute("stroke-dasharray")).not.toBeNull();
  expect(await paths.nth(0).getAttribute("stroke")).not.toBe(await paths.nth(1).getAttribute("stroke"));

  const labels = tab.locator("[data-canvas-arrow-label]");
  expect(await labels.allTextContents()).toEqual(["Continuer", "après choix"]);
  expect(await labels.nth(0).evaluate((el) => (el as HTMLElement).style.left)).toBe("600px");
}, 60_000);

it("draws shapes under the artboards and every other element above them, in list order, arrows included", async () => {
  const project = (await (await server.post("/api/projects", { title: "Stacking" })).json()) as { id: string };
  const page = (await (
    await server.post(`/api/projects/${project.id}/pages`, {
      title: "Stacking",
      files: {
        "a.html": "<!doctype html><body>A</body>",
        "manifest.json": JSON.stringify({
          artboards: [{ file: "a.html", width: 400, height: 300, x: 0, y: 0 }],
          elements: [
            { kind: "sticky", text: "Below the arrow", x: 100, y: 100 },
            { kind: "arrow", from: { x: 0, y: 0 }, to: { x: 600, y: 300 } },
            { kind: "sticky", text: "Above the arrow", x: 200, y: 150 },
            { kind: "shape", shape: "rect", width: 300, height: 200, x: 50, y: 50 },
          ],
        }),
      },
    })
  ).json()) as Page;

  const tab = await browser.newPage({ viewport: { width: 1400, height: 900 } });
  await tab.goto(`${server.url}/#/pages/${page.id}`);
  await tab.locator("[data-canvas-arrow]").waitFor();
  const order = await tab.evaluate(() => {
    const position = (selector: string, nth = 0) => document.querySelectorAll(selector)[nth]!;
    const follows = (a: Element, b: Element) => Boolean(a.compareDocumentPosition(b) & Node.DOCUMENT_POSITION_FOLLOWING);
    const shape = position("[data-canvas-shape]");
    const artboard = position("iframe");
    const below = position("[data-canvas-sticky]", 0);
    const arrow = position("[data-canvas-arrow]");
    const above = position("[data-canvas-sticky]", 1);
    return { shapeUnderArtboard: follows(shape, artboard), artboardUnderNote: follows(artboard, below), listOrder: follows(below, arrow) && follows(arrow, above) };
  });
  expect(order).toEqual({ shapeUnderArtboard: true, artboardUnderNote: true, listOrder: true });
  await tab.close();
}, 60_000);
