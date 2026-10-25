import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { build } from "vite";
import { chromium, type Browser } from "playwright";
import { afterAll, beforeAll, expect, it } from "vitest";
import { CORE_TOKENS, type DesignSystem, type Page } from "@redline/shared";
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

const tokensCss = (primary: string) => `:root {\n${CORE_TOKENS.map((t) => `  ${t}: ${t === "--color-primary" ? primary : "#000"};`).join("\n")}\n}\n`;
const manifestOf = (designSystem: string) =>
  JSON.stringify({ designSystem, artboards: [{ file: "home.html", width: 400, height: 300, x: 0, y: 0 }], elements: [], links: [], tweaks: [] });
const html = (heading: string) => `<!doctype html><h1>${heading}</h1>`;

it("labels an old version with the design system and diffusion it is drawn with", async () => {
  const ds = (await (await server.post("/api/design-systems", { title: "Acme DS", files: { "tokens.css": tokensCss("#111111"), "index.html": html("DS") } })).json()) as DesignSystem;
  const project = (await (await server.post("/api/projects", { title: "Acme" })).json()) as { id: string };
  const page = (await (await server.post(`/api/projects/${project.id}/pages`, {
    title: "Landing",
    files: { "manifest.json": manifestOf(ds.id), "home.html": html("Version one") },
  })).json()) as Page;

  const dsPage = ((await (await server.get(`/api/projects/${ds.id}/pages`)).json()) as Page[])[0];
  await server.post(`/api/pages/${dsPage.id}/versions`, { files: { "tokens.css": tokensCss("#222222"), "index.html": html("DS") }, message: "Edit", origin: "thread" });
  await server.post(`/api/design-systems/${ds.id}/diffusions`, {});
  await server.post(`/api/pages/${page.id}/versions`, {
    files: { "manifest.json": manifestOf(ds.id), "home.html": html("Version two") },
    message: "Second title",
    origin: "thread",
  });

  const tab = await browser.newPage();
  await tab.goto(`${server.url}/#/pages/${page.id}`);
  await tab.getByRole("button", { name: "Historique de home.html" }).click();
  const popover = tab.getByRole("dialog", { name: "Historique de home.html" });
  const versions = popover.getByTestId("history-version");
  await expect.poll(() => versions.count()).toBe(2);
  await expect(versions.first().textContent()).resolves.toContain("affichée avec Acme DS · diffusion 2");
  await expect(versions.nth(1).textContent()).resolves.toContain("affichée avec Acme DS · diffusion 1");

  await versions.nth(1).click();
  await expect(popover.getByTestId("history-preview").textContent()).resolves.toContain("affichée avec Acme DS · diffusion 1");
}, 60_000);
