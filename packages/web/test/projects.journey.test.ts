import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { build } from "vite";
import { type Browser } from "playwright";
import { launchBrowser } from "./journeyBrowser.js";
import { afterAll, beforeAll, expect, it } from "vitest";
import type { Page, Project } from "@redline/shared";
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

it("creates a project, then a page from its overview, and opens it on the canvas", async () => {
  const tab = await browser.newPage();
  await tab.goto(`${server.url}/#/projects`);

  await tab.getByRole("button", { name: "Nouveau projet", exact: true }).click();
  const dialog = tab.getByRole("dialog", { name: "Nouveau projet" });
  await dialog.getByLabel("Titre").fill("Acme");
  await dialog.getByLabel("Instructions").fill("Calm and editorial");
  await dialog.getByRole("button", { name: "Créer le projet" }).click();

  await expect.poll(async () => ((await (await server.get("/api/projects")).json()) as Project[]).length).toBe(1);
  const [project] = (await (await server.get("/api/projects")).json()) as Project[];
  expect(project).toMatchObject({ title: "Acme", instructions: "Calm and editorial", designSystem: null });

  await tab.getByRole("heading", { name: "Acme" }).waitFor();
  await tab.getByRole("navigation", { name: "Fil d'Ariane" }).getByRole("link", { name: "Projets" }).click();
  await tab.getByRole("link", { name: "Acme" }).click();
  await tab.getByRole("heading", { name: "Acme" }).waitFor();

  await tab.getByRole("button", { name: "Nouvelle page" }).first().click();
  const pageDialog = tab.getByRole("dialog", { name: "Nouvelle page" });
  await pageDialog.getByLabel("Nom de la page").fill("Landing");
  await pageDialog.getByRole("button", { name: "Créer la page" }).click();

  await expect.poll(() => tab.url()).toContain("#/pages/");
  await tab.getByTestId("canvas-empty").getByRole("heading", { name: "Cette page est vide" }).waitFor();
  expect(await tab.locator("iframe").count()).toBe(0);

  await tab.getByRole("link", { name: "Acme" }).click();
  const card = tab.getByTestId("page-card").filter({ hasText: "Landing" });
  await card.waitFor();
  await card.getByText("0 artboard").waitFor();
}, 60_000);

it("previews each project with the artboards of its last changed page, on the home and on the Projects screen", async () => {
  const project = (await (await server.post("/api/projects", { title: "Preview" })).json()) as Project;
  const page = (await (await server.post(`/api/projects/${project.id}/pages`, { title: "Landing", files: { "index.html": "<!doctype html><h1>Hi</h1>" } })).json()) as Page;
  await server.post(`/api/projects/${project.id}/pages`, { title: "Pricing", files: { "pricing.html": "<!doctype html><h1>Plans</h1>" } });
  await new Promise((resolve) => setTimeout(resolve, 5));
  await server.post(`/api/pages/${page.id}/versions`, { files: { "index.html": "<!doctype html><h1>Hello</h1>" }, message: "edit", origin: "terminal" });
  const preview = `${server.artboardOrigin}/pages/${page.id}/index.html`;

  const tab = await browser.newPage();
  await tab.goto(`${server.url}/#/projects`);
  const card = tab.getByRole("link").filter({ hasText: "Preview" });
  await expect.poll(() => card.locator("iframe").first().getAttribute("src")).toBe(preview);

  await tab.goto(`${server.url}/#/`);
  const homeCard = tab.getByTestId("home-projects").getByRole("link").filter({ hasText: "Preview" });
  await expect.poll(() => homeCard.locator("iframe").first().getAttribute("src")).toBe(preview);
}, 60_000);

it("shows the Redline logo as the tab icon", async () => {
  const tab = await browser.newPage();
  await tab.goto(`${server.url}/#/projects`);
  const href = await tab.locator('link[rel="icon"]').getAttribute("href");
  const icon = await fetch(new URL(href!, server.url));
  expect(icon.status).toBe(200);
  expect(icon.headers.get("content-type")).toContain("image/svg+xml");
  expect(await icon.text()).toContain("#d92d20");
}, 60_000);
