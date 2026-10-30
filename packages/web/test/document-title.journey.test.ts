import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { build } from "vite";
import { chromium, type Browser } from "playwright";
import { afterAll, beforeAll, expect, it } from "vitest";
import type { DesignSystem, Page, Project } from "@redline/shared";
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

it("names the browser tab after the screen: the page and its project, the project, the design system, or the section", async () => {
  const project = (await (await server.post("/api/projects", { title: "Lumora" })).json()) as Project;
  const page = (await (await server.post(`/api/projects/${project.id}/pages`, { title: "Accueil", files: { "index.html": "<h1>Hi</h1>" } })).json()) as Page;
  const ds = (await (await server.post("/api/design-systems", { title: "DS Lumora" })).json()) as DesignSystem;
  const tab = await browser.newPage();
  const expectTitle = async (hash: string, title: string) => {
    await tab.goto(`${server.url}/${hash}`);
    await expect.poll(() => tab.title()).toBe(title);
  };

  await expectTitle(`#/pages/${page.id}`, "Accueil · Lumora · Redline");
  await expectTitle(`#/projects/${project.id}`, "Lumora · Redline");
  await expectTitle(`#/projects/${project.id}/design-md`, "DESIGN.md · Lumora · Redline");
  await expectTitle(`#/projects/${project.id}/design-system`, "Design system · Lumora · Redline");
  await expectTitle(`#/design-systems/${ds.id}`, "DS Lumora · Redline");
  await expectTitle("#/projects", "Projets · Redline");
  await expectTitle("#/archived-projects", "Projets archivés · Redline");
  await expectTitle("#/design-systems", "Design systems · Redline");
  await expectTitle("#/archived-design-systems", "Design systems archivés · Redline");
  await expectTitle("#/agents", "Agents · Redline");
  await expectTitle("#/sessions", "Sessions · Redline");
  await expectTitle("#/", "Accueil · Redline");
}, 60_000);
