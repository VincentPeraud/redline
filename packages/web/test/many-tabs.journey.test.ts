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

// The browser allows six HTTP/1.1 connections per host: a live stream per tab used to leave the seventh tab with nothing.
it("keeps more tabs than the browser's connections per host working and live, also after the tab holding the stream closes", async () => {
  const project = (await (await server.post("/api/projects", { title: "Tabs" })).json()) as { id: string };
  const page = (await (await server.post(`/api/projects/${project.id}/pages`, { title: "Tabs", files: { "a.html": "<!doctype html><h1>First</h1>" } })).json()) as Page;

  const context = await browser.newContext({ viewport: { width: 1200, height: 800 } });
  const tabs = [];
  for (let i = 0; i < 8; i++) {
    const tab = await context.newPage();
    await tab.goto(`${server.url}/#/pages/${page.id}`);
    await expect.poll(() => tab.frameLocator("iframe").locator("h1").textContent(), { timeout: 5_000 }).toBe("First");
    tabs.push(tab);
  }

  await server.post(`/api/pages/${page.id}/versions`, { files: { "a.html": "<!doctype html><h1>Second</h1>" }, message: "Second", origin: "user" });
  for (const tab of tabs) await expect.poll(() => tab.frameLocator("iframe").locator("h1").textContent(), { timeout: 5_000 }).toBe("Second");

  // The next tab takes the stream over once it has connected: versions published before that reach no tab, so publish until one does.
  await tabs.shift()!.close();
  let attempt = 0;
  await expect
    .poll(async () => {
      attempt++;
      await server.post(`/api/pages/${page.id}/versions`, { files: { "a.html": `<!doctype html><h1>Third ${attempt}</h1>` }, message: "Third", origin: "user" });
      await new Promise((resolve) => setTimeout(resolve, 300));
      return tabs[0].frameLocator("iframe").locator("h1").textContent();
    }, { timeout: 10_000 })
    .toMatch(/^Third/);
  const last = `Third ${attempt}`;
  for (const tab of tabs) await expect.poll(() => tab.frameLocator("iframe").locator("h1").textContent(), { timeout: 5_000 }).toBe(last);
  await context.close();
}, 90_000);
