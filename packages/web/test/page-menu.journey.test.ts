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

it("lists a design system's pages from one of its pages and goes back to the design system", async () => {
  const ds = (await (await server.post("/api/design-systems", { title: "Lumora" })).json()) as { id: string; pageId: string };
  await server.post(`/api/projects/${ds.id}/pages`, { title: "Actions", files });

  const tab = await context.newPage();
  await tab.goto(`${server.url}/#/pages/${ds.pageId}`);
  await expect.poll(() => tab.getByRole("navigation", { name: "Fil d'Ariane" }).getByRole("link", { name: "Lumora" }).count()).toBe(1);
  await tab.getByRole("navigation", { name: "Fil d'Ariane" }).getByRole("button").first().click();

  const menu = tab.getByRole("menu", { name: "Pages du design system Lumora" });
  await expect.poll(() => menu.getByRole("menuitem").allInnerTexts()).toEqual(expect.arrayContaining([expect.stringMatching(/^Actions/)]));
  await expect.poll(() => menu.getByRole("menuitem", { name: /Vue du design system/ }).getAttribute("href")).toBe(`#/design-systems/${ds.id}`);
}, 60_000);

it("scrolls a long list of pages inside the menu, which stays within the window and opens on the current page", async () => {
  const project = (await (await server.post("/api/projects", { title: "Synapse" })).json()) as { id: string };
  const ids: string[] = [];
  for (let i = 1; i <= 30; i++) ids.push(((await (await server.post(`/api/projects/${project.id}/pages`, { title: `Page ${i} · un titre assez long pour être coupé`, files })).json()) as { id: string }).id);
  await server.post(`/api/pages/${ids[20]}/threads`, { body: "À revoir", target: { kind: "artboard", artboard: "home.html" } });

  const tab = await context.newPage();
  await tab.goto(`${server.url}/#/pages/${ids[29]}`);
  await tab.getByRole("button", { name: /^Page 30/ }).first().click();
  const menu = tab.getByRole("menu", { name: "Pages du projet Synapse" });
  await expect.poll(() => menu.getByRole("menuitem").count()).toBeGreaterThanOrEqual(30);
  await expect.poll(() => menu.getByRole("menuitem", { name: /^Page 21/ }).innerText()).toContain("1 fil");

  const box = (await menu.boundingBox())!;
  expect(box.y + box.height).toBeLessThanOrEqual(900);
  // The current page, last of the list, is scrolled into view; the overview link below the list stays reachable.
  const within = async (name: string | RegExp) => {
    const item = (await menu.getByRole("menuitem", { name }).boundingBox())!;
    return item.y >= box.y && item.y + item.height <= box.y + box.height;
  };
  const scrolls = await menu.evaluate((element) => [...element.querySelectorAll("div")].some((div) => div.scrollHeight > div.clientHeight && getComputedStyle(div).overflowY === "auto"));
  expect(scrolls).toBe(true);
  await expect.poll(() => within(/^Page 30/)).toBe(true);
  expect(await within("Vue du projet")).toBe(true);
  expect(await within(/^Page 1 /)).toBe(false);
  // "1 fil" stays on one line.
  const count = menu.getByRole("menuitem", { name: /^Page 21/ }).getByText("1 fil");
  await count.scrollIntoViewIfNeeded();
  expect((await count.boundingBox())!.height).toBeLessThan(24);
  if (process.env.REDLINE_SHOT_DIR) await tab.screenshot({ path: `${process.env.REDLINE_SHOT_DIR}/menu.png` });
}, 60_000);
