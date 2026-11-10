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

it("outlines the hovered element in comment mode and with Alt, and clears it on mouse leave", async () => {
  const project = (await (await server.post("/api/projects", { title: "Hover" })).json()) as { id: string };
  const page = (await (
    await server.post(`/api/projects/${project.id}/pages`, {
      title: "Hover page",
      files: {
        "app.html": `<!doctype html><body style="margin:0;background:#120A1F"><button id="top" style="position:absolute;left:0;top:0;width:100px;height:30px">Top</button><button id="go" style="margin:80px 40px;width:160px;height:40px;border-radius:20px">Réserver ma place</button></body>`,
        "manifest.json": JSON.stringify({ artboards: [{ file: "app.html", title: "App", width: 400, height: 300, x: 0, y: 0 }] }),
      },
    })
  ).json()) as Page;
  const tab = await browser.newPage({ viewport: { width: 1400, height: 900 } });
  await tab.goto(`${server.url}/#/pages/${page.id}`);
  const frame = tab.frameLocator('iframe[title$="app.html"]');
  const button = frame.locator("#go");
  const outline = frame.locator("#__redline-hover [data-part=outline]");
  const label = frame.locator("#__redline-hover [data-part=label]");
  await button.waitFor();
  await new Promise((resolve) => setTimeout(resolve, 300));

  await button.hover();
  expect(await outline.count()).toBe(0);

  await tab.keyboard.down("Alt");
  await button.hover();
  await label.waitFor();
  expect(await label.textContent()).toBe("Bouton · Réserver ma place");
  await tab.keyboard.up("Alt");
  await expect.poll(() => outline.isVisible()).toBe(false);

  await tab.keyboard.press("c");
  await button.hover();
  await expect.poll(() => outline.isVisible()).toBe(true);
  const buttonBox = (await button.boundingBox())!;
  const outlineBox = (await outline.boundingBox())!;
  expect(Math.abs(outlineBox.x - buttonBox.x)).toBeLessThan(2);
  expect(Math.abs(outlineBox.width - buttonBox.width)).toBeLessThan(2);

  await frame.locator("#top").hover();
  await expect.poll(async () => (await label.textContent()) ?? "").toBe("Bouton · Top");
  expect((await label.boundingBox())!.y).toBeGreaterThanOrEqual(0);

  await tab.mouse.move(900, 600);
  await expect.poll(() => outline.isVisible()).toBe(false);

  await button.hover();
  await expect.poll(() => outline.isVisible()).toBe(true);
  await tab.keyboard.press("p");
  await expect.poll(() => outline.isVisible()).toBe(false);
}, 60_000);
