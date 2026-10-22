import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { build } from "vite";
import { chromium, type Browser } from "playwright";
import { afterAll, beforeAll, expect, it } from "vitest";
import type { Page, PageVersionSummary } from "@redline/shared";
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

it("adjusts every tweak type on the canvas and in play mode, versions each change, and restores values", async () => {
  const project = (await (await server.post("/api/projects", { title: "Shop" })).json()) as { id: string };
  const page = (await (
    await server.post(`/api/projects/${project.id}/pages`, {
      title: "Home",
      type: "prototype",
      files: {
        "home.html": "<!doctype html><body><h1>Hello</h1></body>",
        "manifest.json": JSON.stringify({
          artboards: [{ file: "home.html", width: 400, height: 300 }],
          tweaks: [
            { id: "accent", type: "color", label: "Accent", default: "#e5484d" },
            { id: "layout", type: "choice", label: "Layout", options: ["list", "grid"] },
            { id: "search", type: "toggle", label: "Search", default: true },
            { id: "gap", type: "range", label: "Gap", min: 4, max: 24 },
            { id: "cards", type: "count", label: "Cards", min: 1, max: 6, default: 3 },
            { id: "title", type: "text", label: "Title", default: "Welcome" },
          ],
        }),
      },
    })
  ).json()) as Page;

  const tab = await browser.newPage({ viewport: { width: 1400, height: 900 } });
  await tab.goto(server.url);
  const canvasFrame = tab.frameLocator('iframe[title$="home.html"]');
  const attr = (name: string) => () => canvasFrame.locator("html").getAttribute(`data-tweak-${name}`);

  await expect.poll(attr("accent")).toBe("#e5484d");
  await expect.poll(attr("cards")).toBe("3");
  await expect.poll(attr("title")).toBe("Welcome");
  await canvasFrame.locator("html").evaluate(() => {
    (window as unknown as { alive: boolean }).alive = true;
  });

  await tab.getByLabel("Accent").fill("#0f766e");
  await expect.poll(attr("accent")).toBe("#0f766e");
  await tab.getByRole("button", { name: "grid" }).click();
  await expect.poll(attr("layout")).toBe("grid");
  await tab.getByLabel("Search").uncheck();
  await expect.poll(attr("search")).toBe("false");
  await tab.getByLabel("Gap").fill("12");
  await expect.poll(attr("gap")).toBe("12");
  await tab.getByRole("button", { name: "Increase Cards" }).click();
  await expect.poll(attr("cards")).toBe("4");
  await tab.getByLabel("Title").fill("Hi there");
  await expect.poll(attr("title")).toBe("Hi there");

  const versions = async () => (await (await server.get(`/api/pages/${page.id}/versions`)).json()) as PageVersionSummary[];
  const tweaksFile = async () => JSON.parse(await (await server.get(`/api/pages/${page.id}/files/tweaks.json`)).text());
  await expect
    .poll(async () => (await versions()).filter((v) => v.origin === "tweak").length, { timeout: 10_000 })
    .toBe(6);
  expect(await tweaksFile()).toEqual({ accent: "#0f766e", layout: "grid", search: false, gap: 12, cards: 4, title: "Hi there" });
  expect(await canvasFrame.locator("html").evaluate(() => (window as unknown as { alive?: boolean }).alive)).toBe(true);
  const html = await (await server.get(`/api/pages/${page.id}/files/home.html`)).text();
  expect(html).toBe("<!doctype html><body><h1>Hello</h1></body>");

  await tab.getByRole("button", { name: "Play" }).click();
  const playFrame = tab.frameLocator('[data-testid="play"] iframe');
  const playAttr = (name: string) => () => playFrame.locator("html").getAttribute(`data-tweak-${name}`);
  await expect.poll(playAttr("accent")).toBe("#0f766e");
  await tab.getByLabel("Search").check();
  await expect.poll(playAttr("search")).toBe("true");
  await expect.poll(async () => (await versions())[0]?.message, { timeout: 10_000 }).toBe("Tweak: Search = true");
  await tab.getByRole("button", { name: /Exit play/ }).click();

  const accentVersion = (await versions()).find((v) => v.message === "Tweak: Accent = #0f766e")!;
  await server.post(`/api/pages/${page.id}/versions/${accentVersion.id}/restore`, {});
  await tab.reload();
  await expect.poll(attr("accent")).toBe("#0f766e");
  await expect.poll(attr("layout")).toBe("list");
  await expect.poll(attr("search")).toBe("true");
  await expect.poll(attr("gap")).toBe("4");
  await expect.poll(attr("title")).toBe("Welcome");
}, 90_000);
