import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { build } from "vite";
import { chromium, type Browser, type BrowserContext } from "playwright";
import { afterAll, afterEach, beforeAll, expect, it } from "vitest";
import { MANIFEST_PATH } from "@redline/shared";
import { startTestServer, type TestServer } from "@redline/server/test-harness";

const webRoot = fileURLToPath(new URL("..", import.meta.url));

let server: TestServer;
let browser: Browser;
let webDir: string;
let context: BrowserContext;

beforeAll(async () => {
  webDir = mkdtempSync(join(tmpdir(), "redline-web-"));
  await build({ root: webRoot, logLevel: "silent", build: { outDir: webDir, emptyOutDir: true } });
  server = await startTestServer({ webDir });
  browser = await chromium.launch();
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

const files = { "home.html": "<h1>Home</h1>", [MANIFEST_PATH]: JSON.stringify({ artboards: [{ file: "home.html", x: 0, y: 0 }] }) };

it("lists the project's pages even when their open thread counts are slow or fail", async () => {
  const project = (await (await server.post("/api/projects", { title: "Radio" })).json()) as { id: string };
  const sortie = (await (await server.post(`/api/projects/${project.id}/pages`, { title: "Sortie", files })).json()) as { id: string };
  const archive = (await (await server.post(`/api/projects/${project.id}/pages`, { title: "Archive · Sortie", files })).json()) as { id: string };
  await server.post(`/api/pages/${sortie.id}/threads`, { body: "À revoir", target: { kind: "artboard", artboard: "home.html" } });

  const tab = await context.newPage();
  // One count fails, the other never comes back while the menu is open.
  await tab.route(`**/api/pages/${archive.id}/threads`, (route) => route.abort());
  let releaseSlow: () => void = () => {};
  const slow = new Promise<void>((resolve) => (releaseSlow = resolve));
  await tab.route(`**/api/pages/${sortie.id}/threads`, async (route) => {
    await slow;
    await route.continue();
  });
  await tab.goto(`${server.url}/#/pages/${sortie.id}`);
  await tab.getByRole("button", { name: "Sortie" }).first().click();

  const menu = tab.getByRole("menu", { name: "Pages du projet Radio" });
  await expect.poll(() => menu.getByRole("menuitem").allInnerTexts()).toEqual(expect.arrayContaining([expect.stringContaining("Archive · Sortie"), expect.stringMatching(/^Sortie/)]));
  releaseSlow();
  await expect.poll(() => menu.getByRole("menuitem", { name: /^Sortie/ }).innerText()).toContain("1 fil");
}, 60_000);

it("opens a single server events stream per tab, so the browser's six connections per host stay free for the page's requests", async () => {
  const project = (await (await server.post("/api/projects", { title: "Flux" })).json()) as { id: string };
  const page = (await (await server.post(`/api/projects/${project.id}/pages`, { title: "Accueil", files })).json()) as { id: string };

  const tab = await context.newPage();
  const streams: string[] = [];
  tab.on("request", (request) => request.url().endsWith("/api/events") && streams.push(request.url()));
  await tab.goto(`${server.url}/#/pages/${page.id}`);
  await tab.getByRole("button", { name: "Accueil" }).first().click();
  await expect.poll(() => tab.getByRole("menu", { name: "Pages du projet Flux" }).getByRole("menuitem").count()).toBeGreaterThan(0);
  await tab.waitForTimeout(500);

  expect(streams).toHaveLength(1);
}, 60_000);
