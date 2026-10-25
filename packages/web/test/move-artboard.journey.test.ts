import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { build } from "vite";
import { chromium, type Browser, type BrowserContext, type Locator } from "playwright";
import { afterAll, afterEach, beforeAll, beforeEach, expect, it } from "vitest";
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
  context = await browser.newContext({ viewport: { width: 1440, height: 900 }, permissions: ["clipboard-read", "clipboard-write"] });
  await context.tracing.start({ screenshots: true, snapshots: true });
}, 60_000);

// These journeys once timed out together under a full run and never again: record each test so a failure leaves a trace to open with `npx playwright show-trace`.
beforeEach(async () => {
  await context.tracing.startChunk();
});

afterEach(async ({ task }) => {
  if (task.result?.state === "fail") {
    const path = join(tmpdir(), `redline-trace-${task.name.slice(0, 40).replace(/\W+/g, "-")}-${Date.now()}.zip`);
    await context.tracing.stopChunk({ path });
    console.log(`Playwright trace of the failed journey: ${path}`);
  } else {
    await context.tracing.stopChunk();
  }
  // A failed journey leaves its tabs open: close them so the next journey starts alone in the context.
  await Promise.all(context.pages().map((page) => page.close()));
});

afterAll(async () => {
  await browser?.close();
  await server?.stop();
  rmSync(webDir, { recursive: true, force: true });
});

const html = `<!doctype html><body style="margin:0"><h1>Hi</h1></body>`;

async function createProject(): Promise<string> {
  return ((await (await server.post("/api/projects", { title: "Acme" })).json()) as { id: string }).id;
}

async function createPage(projectId: string, title: string, files: Record<string, string>, manifest: object): Promise<string> {
  const page = (await server
    .post(`/api/projects/${projectId}/pages`, { title, files: { ...files, "manifest.json": JSON.stringify(manifest) } })
    .then((res) => res.json())) as { id: string };
  return page.id;
}

const artboards = (...files: string[]) => ({ artboards: files.map((file, i) => ({ file, title: file, width: 300, height: 200, x: i * 400, y: 0 })) });
const filesOf = async (pageId: string): Promise<string[]> =>
  Object.keys(((await (await server.get(`/api/pages/${pageId}`)).json()) as { version: { files: Record<string, string> } }).version.files).sort();

it("moves an artboard to another page of the project from the ⋯ menu, with the same menu as board DsCatalog", async () => {
  const projectId = await createProject();
  const web = await createPage(projectId, "Web", { "btn.html": html, "home.html": html }, artboards("btn.html", "home.html"));
  const boutons = await createPage(projectId, "Boutons", { "link.html": html }, artboards("link.html"));
  const tab = await context.newPage();
  await tab.goto(`${server.url}/#/pages/${web}`);
  await tab.getByRole("button", { name: "Autres actions pour btn.html" }).click();
  const menu = tab.getByRole("menu", { name: "Autres actions pour btn.html" });

  await menu.getByRole("menuitem", { name: "Boutons" }).waitFor();
  expect(await menu.getByRole("menuitem").allTextContents()).toEqual(["Copier le lien plein écran", "Boutons", "+ Nouvelle page…"]);
  await menu.getByText("Déplacer vers").waitFor();
  await menu.getByRole("menuitem", { name: "Boutons" }).click();

  await tab.locator('[data-artboard="btn.html"]').waitFor({ state: "detached" });
  expect(await tab.locator('[data-artboard="home.html"]').count()).toBe(1);
  expect(await filesOf(web)).toEqual(["home.html", "manifest.json"]);
  expect(await filesOf(boutons)).toEqual(["btn.html", "link.html", "manifest.json"]);
  await tab.close();
}, 60_000);

it("moves an artboard to a new page typed in a small dialog", async () => {
  const projectId = await createProject();
  const web = await createPage(projectId, "Web", { "btn.html": html, "home.html": html }, artboards("btn.html", "home.html"));
  const tab = await context.newPage();
  await tab.goto(`${server.url}/#/pages/${web}`);
  await tab.getByRole("button", { name: "Autres actions pour btn.html" }).click();
  await tab.getByRole("menuitem", { name: "+ Nouvelle page…" }).click();

  const dialog = tab.getByRole("dialog", { name: "Nouvelle page" });
  await dialog.getByLabel("Nom de la page").fill("Formulaires");
  await dialog.getByRole("button", { name: "Créer et déplacer" }).click();

  await tab.locator('[data-artboard="btn.html"]').waitFor({ state: "detached" });
  const pages = (await (await server.get(`/api/projects/${projectId}/pages`)).json()) as { id: string; title: string }[];
  const created = pages.find((page) => page.title === "Formulaires")!;
  expect(await filesOf(created.id)).toEqual(["btn.html", "manifest.json"]);
  await tab.close();
}, 60_000);

it("says why a move is refused and leaves the artboard where it is", async () => {
  const projectId = await createProject();
  const web = await createPage(projectId, "Web", { "btn.html": html, "home.html": html }, artboards("btn.html", "home.html"));
  await createPage(projectId, "Boutons", { "btn.html": "<p>already</p>" }, artboards("btn.html"));
  const tab = await context.newPage();
  await tab.goto(`${server.url}/#/pages/${web}`);
  await tab.getByRole("button", { name: "Autres actions pour btn.html" }).click();
  await tab.getByRole("menuitem", { name: "Boutons" }).click();

  const dialog = tab.getByRole("dialog", { name: "Déplacement impossible" });
  await dialog.getByText("« Boutons » a déjà un fichier nommé btn.html.").waitFor();
  await dialog.getByRole("button", { name: "Fermer" }).first().click();
  expect(await tab.locator('[data-artboard="btn.html"]').count()).toBe(1);
  expect(await filesOf(web)).toEqual(["btn.html", "home.html", "manifest.json"]);
  await tab.close();
}, 60_000);
