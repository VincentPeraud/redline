import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { copyBuiltWeb } from "./builtWeb.js";
import { type Browser } from "playwright";
import { launchBrowser } from "./journeyBrowser.js";
import { afterAll, beforeAll, expect, it } from "vitest";
import type { Page } from "@redline/shared";
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

it("draws text and sticky notes with markdown, palette colours and three visibly different sizes", async () => {
  const project = (await (await server.post("/api/projects", { title: "Notes" })).json()) as { id: string };
  const page = (await (
    await server.post(`/api/projects/${project.id}/pages`, {
      title: "Notes",
      files: {
        "a.html": "<!doctype html><body>A</body>",
        "manifest.json": JSON.stringify({
          artboards: [{ file: "a.html", width: 400, height: 300, x: 0, y: 0 }],
          elements: [
            { kind: "text", text: "Plain **bold** and *italic* [docs](https://example.com/docs) `code`\n\n- first\n- second", x: 0, y: 400 },
            { kind: "text", text: "Blue words", color: "blue", x: 0, y: 700 },
            { kind: "sticky", text: "Small", size: "s", x: 500, y: 0 },
            { kind: "sticky", text: "Medium", x: 500, y: 200 },
            { kind: "sticky", text: "Large", size: "l", color: "pink", x: 500, y: 400 },
          ],
        }),
      },
    })
  ).json()) as Page;

  const tab = await browser.newPage({ viewport: { width: 1400, height: 900 } });
  await tab.goto(`${server.url}/#/pages/${page.id}`);
  const text = tab.locator("[data-canvas-text]").first();
  await text.waitFor();
  expect(await text.locator("strong").textContent()).toBe("bold");
  expect(await text.locator("em").textContent()).toBe("italic");
  expect(await text.locator("li").count()).toBe(2);
  expect(await text.textContent()).toContain("`code`");
  const link = text.locator("a");
  expect(await link.getAttribute("href")).toBe("https://example.com/docs");
  expect(await link.getAttribute("target")).toBe("_blank");
  expect(await link.getAttribute("rel")).toContain("noopener");

  const blue = tab.locator("[data-canvas-text]").filter({ hasText: "Blue words" });
  const normalColour = await text.evaluate((el) => getComputedStyle(el).color);
  expect(await blue.evaluate((el) => getComputedStyle(el).color)).not.toBe(normalColour);

  const sticky = (name: string) => tab.locator("[data-canvas-sticky]").filter({ hasText: name });
  const fontSize = (name: string) => sticky(name).evaluate((el) => parseFloat(getComputedStyle(el).fontSize));
  const small = await fontSize("Small");
  const medium = await fontSize("Medium");
  const large = await fontSize("Large");
  expect(small).toBeLessThan(medium);
  expect(medium).toBeLessThan(large);

  const background = (name: string) => sticky(name).evaluate((el) => getComputedStyle(el).backgroundColor);
  expect(await background("Medium")).toBe("rgb(254, 243, 199)");
  expect(await background("Large")).toBe("rgb(252, 231, 243)");
}, 60_000);
