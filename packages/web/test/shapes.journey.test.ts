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

it("draws outline and fill shapes with palette colours and a label, under the artboards whatever their list position", async () => {
  const project = (await (await server.post("/api/projects", { title: "Shapes" })).json()) as { id: string };
  const page = (await (
    await server.post(`/api/projects/${project.id}/pages`, {
      title: "Shapes",
      files: {
        "a.html": "<!doctype html><body>A</body>",
        "manifest.json": JSON.stringify({
          artboards: [{ file: "a.html", width: 400, height: 300, x: 0, y: 0 }],
          elements: [
            { kind: "shape", shape: "rect", style: "fill", color: "blue", label: "Variante A", x: -50, y: -50, width: 300, height: 200 },
            { kind: "shape", shape: "ellipse", color: "orange", x: 500, y: 0, width: 220, height: 64 },
          ],
        }),
      },
    })
  ).json()) as Page;

  const tab = await browser.newPage({ viewport: { width: 1400, height: 900 } });
  await tab.goto(`${server.url}/#/pages/${page.id}`);
  const shapes = tab.locator("[data-canvas-shape]");
  await shapes.first().waitFor();
  expect(await shapes.count()).toBe(2);

  const filled = shapes.nth(0);
  expect(await filled.textContent()).toBe("Variante A");
  expect(await filled.evaluate((el) => getComputedStyle(el).backgroundColor)).not.toBe("rgba(0, 0, 0, 0)");
  expect(await filled.evaluate((el) => getComputedStyle(el).borderTopWidth)).toBe("0px");

  const outline = shapes.nth(1);
  expect(await outline.evaluate((el) => getComputedStyle(el).backgroundColor)).toBe("rgba(0, 0, 0, 0)");
  expect(await outline.evaluate((el) => getComputedStyle(el).borderTopColor)).toBe("rgb(234, 88, 12)");
  expect(await outline.evaluate((el) => getComputedStyle(el).borderTopLeftRadius)).toBe("50%");

  const overArtboard = await tab.evaluate(() => {
    const shape = document.querySelector("[data-canvas-shape]")!;
    const rect = shape.getBoundingClientRect();
    const artboard = document.querySelector("iframe")!.getBoundingClientRect();
    const x = (Math.max(rect.left, artboard.left) + Math.min(rect.right, artboard.right)) / 2;
    const y = (Math.max(rect.top, artboard.top) + Math.min(rect.bottom, artboard.bottom)) / 2;
    return document.elementFromPoint(x, y)?.closest("[data-canvas-shape]") === null;
  });
  expect(overArtboard).toBe(true);
}, 60_000);
