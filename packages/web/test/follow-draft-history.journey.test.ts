import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { copyBuiltWeb } from "./builtWeb.js";
import { type Browser } from "playwright";
import { launchBrowser } from "./journeyBrowser.js";
import { afterAll, beforeAll, expect, it } from "vitest";
import { CORE_TOKENS, type DesignSystem, type Page, type Project } from "@redline/shared";
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

const tokensCss = `:root {\n${CORE_TOKENS.map((t) => `  ${t}: #112233;`).join("\n")}\n}\n`;
const manifestOf = (designSystem?: string) => JSON.stringify({ ...(designSystem && { designSystem }), artboards: [{ file: "home.html", width: 400, height: 300, x: 0, y: 0 }] });
const html = (heading: string) => `<!doctype html><h1>${heading}</h1>`;
const put = (path: string, body: unknown) => fetch(server.url + path, { method: "PUT", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });

it("labels a version published on the draft, and logs the setting changes in the style history", async () => {
  const ds = (await (await server.post("/api/design-systems", { title: "Lumora", files: { "tokens.css": tokensCss, "index.html": html("DS") } })).json()) as DesignSystem;
  const project = (await (await server.post("/api/projects", { title: "Halloween", designSystem: ds.id })).json()) as Project;
  await put(`/api/projects/${project.id}/design-system`, { followsDraft: true });
  const page = (await (await server.post(`/api/projects/${project.id}/pages`, { title: "Landing", files: { "manifest.json": manifestOf(ds.id), "home.html": html("One") } })).json()) as Page;
  await put(`/api/projects/${project.id}/design-system`, { followsDraft: false });
  await server.post(`/api/pages/${page.id}/versions`, { files: { "manifest.json": manifestOf(ds.id), "home.html": html("Two") }, message: "Two", origin: "thread" });

  const tab = await browser.newPage();
  await tab.goto(`${server.url}/#/pages/${page.id}`);
  await tab.getByRole("button", { name: "Historique de home.html" }).click();
  const versions = tab.getByRole("dialog", { name: "Historique de home.html" }).getByTestId("history-version");
  await expect.poll(() => versions.count()).toBe(2);
  await expect(versions.first().textContent()).resolves.toContain("affichée avec Lumora · diffusion 1");
  await expect(versions.nth(1).textContent()).resolves.toContain("affichée avec le brouillon actuel de Lumora · publiée après la diffusion 1");

  await tab.goto(`${server.url}/#/projects/${project.id}/design-system`);
  await tab.getByRole("button", { name: "Historique" }).click();
  const history = tab.getByRole("dialog", { name: "Historique du style du projet" });
  await history.getByText("Suit la dernière diffusion de Lumora").waitFor();
  await history.getByText("Suit le brouillon de Lumora").waitFor();
  await tab.close();
}, 60_000);
