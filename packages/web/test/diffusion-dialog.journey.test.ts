import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { copyBuiltWeb } from "./builtWeb.js";
import { type Browser } from "playwright";
import { launchBrowser } from "./journeyBrowser.js";
import { afterAll, beforeAll, expect, it } from "vitest";
import { CORE_TOKENS, type DesignSystem, type DesignSystemDetail, type Page } from "@redline/shared";
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
  const tokenRow = dialog.getByTestId("review-change").first();
  expect(await tokenRow.textContent()).toContain("--color-primary#111111→#222222fait directement dans le design system");
  expect(await tokenRow.locator('span[aria-hidden="true"][style]').count()).toBe(2);
  const cards = await dialog.getByTestId("diffusion-component").allTextContents();
  expect(cards.map((card) => card.replace(/Où ça change.*$/, ""))).toEqual([
    "ui-cardmodifiéAvant / après ↗Ce qui changeModification sans descriptionfait directement dans le design system",
    "ui-badgenouveauVoir le composant ↗Ce qui changeModification sans descriptionfait directement dans le design system",
  ]);
  expect(await dialog.getByText("Nulle part pour l'instant : aucune page n'utilise encore ui-badge").count()).toBe(1);
  expect(await dialog.getByText("Nulle part pour l'instant : aucune page n'utilise encore ui-card").count()).toBe(1);
  if (process.env.REDLINE_CAPTURES) await dialog.getByTestId("diffusion-component").first().screenshot({ path: join(process.env.REDLINE_CAPTURES, "fix-diffuse-app-card.png") });
  expect(await dialog.getByTestId("diffusion-override").textContent()).toContain("Semaine Halloween surcharge --color-primary : ce changement y sera sans effet.");

  await dialog.getByRole("button", { name: "Annuler" }).click();
  await expect.poll(async () => tab.getByRole("dialog").count()).toBe(0);

  await button.click();
  await tab.getByRole("button", { name: "Diffuser", exact: true }).click();
  await expect.poll(async () => tab.getByTestId("diffusion-toast").textContent()).toBe("Diffusion 2 envoyée à 2 projetsAnnuler");
  await expect.poll(async () => tab.getByRole("dialog").count()).toBe(0);
  await expect.poll(async () => tab.getByRole("button", { name: /Diffuser aux projets/ }).count()).toBe(0);
  expect(((await (await server.get(`/api/design-systems/${ds.id}`)).json()) as DesignSystemDetail).current.number).toBe(2);

  // A project's page has no diffuse button.
  const projectPage = (await (await server.post(`/api/projects/${halloween.id}/pages`, { title: "Home", files: { "index.html": "<html><head></head><body>x</body></html>", "manifest.json": manifestOf(["index.html"]) } })).json()) as Page;
  await tab.goto(`${server.url}/#/pages/${projectPage.id}`);
  await expect.poll(async () => tab.getByTestId("canvas").count()).toBe(1);
  expect(await tab.getByRole("button", { name: /Diffuser aux projets/ }).count()).toBe(0);
  await tab.close();
}, 30_000);

it("counts the instances of a changed component, folds the pages behind Voir les pages and links each to its preview", async () => {
  const modal = (template: string) => `<!doctype html><html><head><style data-component>ui-modal{display:block}</style></head><body><template data-component>${template}</template></body></html>`;
  const ds = (await (await server.post("/api/design-systems", {
    title: "Lumora",
    files: { "tokens.css": tokensCss("#111111"), "manifest.json": manifestOf(["components/modal.html"]), "components/modal.html": modal('<div class="m"><slot></slot></div>') },
  })).json()) as DesignSystem;
  const app = (await (await server.post("/api/projects", { title: "App", designSystem: ds.id })).json()) as { id: string };
  const planning = (await (await server.post(`/api/projects/${app.id}/pages`, {
    title: "Planning",
    files: { "index.html": "<!doctype html><html><head></head><body><ui-modal></ui-modal><ui-modal></ui-modal></body></html>", "manifest.json": manifestOf(["index.html"], ds.id) },
  })).json()) as Page;
  const dsPage = ((await (await server.get(`/api/projects/${ds.id}/pages`)).json()) as Page[])[0]!;
  await server.post(`/api/pages/${dsPage.id}/versions`, {
    files: { "tokens.css": tokensCss("#111111"), "manifest.json": manifestOf(["components/modal.html"]), "components/modal.html": modal('<div class="m wide"><slot></slot></div>') },
    message: "Edit",
    origin: "thread",
  });

  const tab = await browser.newPage({ viewport: { width: 1440, height: 1000 } });
  await tab.goto(`${server.url}/#/design-systems/${ds.id}`);
  await tab.getByRole("button", { name: "Diffuser…" }).click();
  const card = tab.getByTestId("diffusion-component");
  await card.waitFor();
  expect(await card.textContent()).toContain("2 instances dans 1 page de projets");
  expect(await tab.getByTestId("review-page").count()).toBe(0);

  await card.getByRole("button", { name: "Voir les pages" }).click();
  const row = tab.getByTestId("review-page");
  expect(await row.textContent()).toContain("AppPlanning2 instances");
  expect(await row.getByRole("link", { name: /Aperçu/ }).getAttribute("href")).toContain(`#/pages/${planning.id}?apercu=${ds.id}`);
  await card.getByRole("button", { name: "Masquer les pages" }).click();
  expect(await tab.getByTestId("review-page").count()).toBe(0);
  await tab.close();
}, 30_000);
