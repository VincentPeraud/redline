import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { copyBuiltWeb } from "./builtWeb.js";
import { type Browser, type BrowserContext } from "playwright";
import { launchBrowser } from "./journeyBrowser.js";
import { afterAll, afterEach, beforeAll, expect, it } from "vitest";
import { MANIFEST_PATH } from "@redline/shared";
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

it("selects no text when the mouse drags over the canvas or an artboard", async () => {
  const project = (await (await server.post("/api/projects", { title: "Radio" })).json()) as { id: string };
  const page = (await (
    await server.post(`/api/projects/${project.id}/pages`, {
      title: "Sortie",
      files: {
        "home.html": "<!doctype html><body style='margin:0'><h1>Accueil de la radio</h1><p>Un long texte qui se laisse sélectionner.</p><input value='Radio HAIDF'></body>",
        [MANIFEST_PATH]: JSON.stringify({
          artboards: [{ file: "home.html", title: "Accueil", x: 0, y: 0, width: 400, height: 300 }],
          elements: [
            { kind: "title", id: "t", text: "Sortie · rejeu", subtitle: "Deux écrans", x: 0, y: -160 },
            { kind: "sticky", id: "s", text: "Une note à lire", x: 0, y: 340 },
            { kind: "text", id: "n", text: "## Ce que montre l'écran\n- Traces jouées jusqu'à la tête de lecture\n- Lecteur ×1 / ×10 / ×30", x: 300, y: 340 },
          ],
        }),
      },
    })
  ).json()) as { id: string };
  const tab = await context.newPage();
  await tab.goto(`${server.url}/#/pages/${page.id}`);
  await tab.locator('[data-artboard="home.html"] iframe').waitFor();
  await tab.waitForTimeout(500);

  // From empty canvas, across the group title, the strip, the sticky and the artboard.
  const canvas = (await tab.getByTestId("canvas").boundingBox())!;
  await tab.mouse.move(canvas.x + 20, canvas.y + 20);
  await tab.mouse.down();
  for (let step = 1; step <= 20; step++) await tab.mouse.move(canvas.x + 20 + step * 40, canvas.y + 20 + step * 30);
  await tab.mouse.up();
  expect(await tab.evaluate(() => window.getSelection()?.toString() ?? "")).toBe("");

  // A drag that starts on a canvas element (note, sticky, group title) selects nothing either.
  for (const id of ["n", "s", "t"]) {
    const box = (await tab.locator(`[data-canvas-element-id="${id}"]`).boundingBox())!;
    await tab.mouse.move(box.x + 12, box.y + 12);
    await tab.mouse.down();
    for (let step = 1; step <= 10; step++) await tab.mouse.move(box.x + 12 + step * 15, box.y + 12 + step * 12);
    await tab.mouse.up();
    expect(await tab.evaluate(() => window.getSelection()?.toString() ?? "")).toBe("");
  }

  // A drag that starts on the artboard's text selects nothing either, while its text fields keep their selection.
  const frame = tab.frameLocator('[data-artboard="home.html"] iframe');
  const heading = (await frame.locator("h1").boundingBox())!;
  await tab.mouse.move(heading.x + 4, heading.y + heading.height / 2);
  await tab.mouse.down();
  for (let step = 1; step <= 10; step++) await tab.mouse.move(heading.x + 4 + step * 20, heading.y + heading.height / 2 + step * 4);
  await tab.mouse.up();
  expect(await frame.locator("body").evaluate(() => window.getSelection()?.toString() ?? "")).toBe("");
  const field = frame.locator("input");
  await field.click();
  await tab.keyboard.press("ControlOrMeta+a");
  expect(await field.evaluate((input: HTMLInputElement) => input.value.slice(input.selectionStart ?? 0, input.selectionEnd ?? 0))).toBe("Radio HAIDF");
}, 60_000);
