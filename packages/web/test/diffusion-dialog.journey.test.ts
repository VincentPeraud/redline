import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { build } from "vite";
import { type Browser } from "playwright";
import { launchBrowser } from "./journeyBrowser.js";
import { afterAll, beforeAll, expect, it } from "vitest";
import { CORE_TOKENS, type DesignSystem, type DesignSystemDetail, type Page } from "@redline/shared";
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

const tokensCss = (primary: string) => `:root {\n${CORE_TOKENS.map((t) => `  ${t}: ${t === "--color-primary" ? primary : "#000000"};`).join("\n")}\n}\n`;
const component = (css: string) => `<!doctype html><html><head><style data-component>${css}</style></head><body><div class="card">Hi</div></body></html>`;
const manifestOf = (files: string[]) => JSON.stringify({ artboards: files.map((file, i) => ({ file, x: i * 300, y: 0, width: 200, height: 100 })) });

it("shows the diffuse button while changes are pending, lists them with the override warning, and diffuses", async () => {
  const ds = (await (await server.post("/api/design-systems", {
    title: "Lumora",
    files: { "tokens.css": tokensCss("#111111"), "manifest.json": manifestOf(["components/card.html"]), "components/card.html": component(".card{color:red}") },
  })).json()) as DesignSystem;
  const halloween = (await (await server.post("/api/projects", { title: "Semaine Halloween", designSystem: ds.id })).json()) as { id: string };
  await server.post("/api/projects", { title: "lumora.com", designSystem: ds.id });
  await fetch(`${server.url}/api/projects/${halloween.id}/project-style`, { method: "PUT", headers: { "content-type": "application/json" }, body: JSON.stringify({ content: ":root { --color-primary: #ff6600; }" }) });

  const tab = await browser.newPage();
  await tab.goto(`${server.url}/#/pages/${ds.pageId}`);
  await expect.poll(async () => tab.getByTestId("canvas").count()).toBe(1);
  expect(await tab.getByRole("button", { name: /Diffuser aux projets/ }).count()).toBe(0);

  const page = ((await (await server.get(`/api/projects/${ds.id}/pages`)).json()) as Page[])[0]!;
  const published = await server.post(`/api/pages/${page.id}/versions`, {
    files: { "tokens.css": tokensCss("#222222"), "manifest.json": manifestOf(["components/card.html", "components/badge.html"]), "components/card.html": component(".card{color:blue}"), "components/badge.html": component(".badge{color:green}") },
    message: "Edit",
    origin: "thread",
  });

  expect(published.status, await published.clone().text()).toBe(201);
  const button = tab.getByRole("button", { name: /Diffuser aux projets/ });
  await expect.poll(async () => button.textContent({ timeout: 1000 }).catch(() => ""), { timeout: 5000 }).toContain("3");

  await button.click();
  const dialog = tab.getByRole("dialog", { name: "Diffuser la version 2 de Lumora" });
  await dialog.waitFor();
  expect(await dialog.getByTestId("diffusion-token").textContent()).toContain("--color-primary#111111→#222222");
  const cards = await dialog.getByTestId("diffusion-component").allTextContents();
  expect(cards).toEqual(["cardmodifié→", "badgenouveau"]);
  expect(await dialog.getByRole("img", { name: "Avant" }).count()).toBe(1);
  expect(await dialog.getByRole("img", { name: "Après" }).count()).toBe(2);
  expect(await dialog.textContent()).toContain("Projets concernés · 2");
  expect(await dialog.getByTestId("diffusion-override").textContent()).toContain("Semaine Halloween surcharge --color-primary : ce changement y sera sans effet.");

  await dialog.getByRole("button", { name: "Annuler" }).click();
  expect(await tab.getByRole("dialog").count()).toBe(0);

  await button.click();
  await tab.getByRole("button", { name: "Diffuser", exact: true }).click();
  await expect.poll(async () => tab.getByTestId("diffusion-toast").textContent()).toBe("Diffusion 2 envoyée à 2 projetsAnnuler");
  expect(await tab.getByRole("dialog").count()).toBe(0);
  await expect.poll(async () => tab.getByRole("button", { name: /Diffuser aux projets/ }).count()).toBe(0);
  expect(((await (await server.get(`/api/design-systems/${ds.id}`)).json()) as DesignSystemDetail).current.number).toBe(2);

  // A project's page has no diffuse button.
  const projectPage = (await (await server.post(`/api/projects/${halloween.id}/pages`, { title: "Home", files: { "index.html": "<html><head></head><body>x</body></html>", "manifest.json": manifestOf(["index.html"]) } })).json()) as Page;
  await tab.goto(`${server.url}/#/pages/${projectPage.id}`);
  await expect.poll(async () => tab.getByTestId("canvas").count()).toBe(1);
  expect(await tab.getByRole("button", { name: /Diffuser aux projets/ }).count()).toBe(0);
  await tab.close();
}, 30_000);
