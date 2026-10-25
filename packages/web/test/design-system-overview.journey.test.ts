import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { build } from "vite";
import { chromium, type Browser } from "playwright";
import { afterAll, beforeAll, expect, it } from "vitest";
import { CORE_TOKENS, type DesignSystem, type Page, type Project } from "@redline/shared";
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

const tokensCss = (primary: string) => `:root {\n${CORE_TOKENS.map((t) => `  ${t}: ${t === "--color-primary" ? primary : "#123456"};`).join("\n")}\n}\n`;
const component = (css: string) => `<!doctype html><html><head><style data-component>${css}</style></head><body></body></html>`;
const manifestOf = (files: string[]) => JSON.stringify({ artboards: files.map((file, i) => ({ file, x: i * 300, y: 0, width: 200, height: 100 })) });
const json = (body: unknown) => ({ method: "PUT", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });

async function seed() {
  const ds = (await (await server.post("/api/design-systems", {
    title: "Lumora",
    files: { "tokens.css": tokensCss("#f25c2a"), "manifest.json": manifestOf(["components/btn.html"]), "components/btn.html": component(".btn{color:red}") },
  })).json()) as DesignSystem;
  const first = ((await (await server.get(`/api/projects/${ds.id}/pages`)).json()) as Page[])[0]!;
  const social = (await (await server.post(`/api/projects/${ds.id}/pages`, {
    title: "Réseaux sociaux",
    files: { "manifest.json": manifestOf(["components/story-frame.html"]), "components/story-frame.html": component(".s{}") },
  })).json()) as Page;
  await server.post(`/api/design-systems/${ds.id}/diffusions`, {});
  await server.post(`/api/pages/${social.id}/versions`, {
    files: { "manifest.json": manifestOf(["components/story-frame.html"]), "components/story-frame.html": component(".s{color:blue}") },
    message: "Edit",
    origin: "thread",
  });
  await fetch(`${server.url}/api/projects/${ds.id}/design-md`, json({ content: "# Marque Lumora\n\n- Le logo jamais sur fond orange\n- On tutoie, phrases courtes\n" }));
  const halloween = (await (await server.post("/api/projects", { title: "Semaine Halloween", designSystem: ds.id })).json()) as Project;
  await fetch(`${server.url}/api/projects/${halloween.id}/project-style`, json({ content: ":root { --color-primary: #ff6600; }" }));
  await server.post("/api/projects", { title: "lumora.com", designSystem: ds.id });
  return { ds, first, social };
}

it("shows the design system overview: pages, pending changes, diffusions, projects using it and DESIGN.md", async () => {
  const { ds, social } = await seed();
  const tab = await browser.newPage({ viewport: { width: 1440, height: 1100 } });
  await tab.goto(`${server.url}/#/design-systems/${ds.id}`);

  await tab.getByRole("heading", { name: "Lumora", level: 1 }).waitFor();
  expect(await tab.getByTestId("ds-stats").innerText()).toBe(`Design system · 2 pages · 2 composants · ${CORE_TOKENS.length} tokens · diffusion 2 en cours`);
  expect(await tab.getByTestId("pending-banner").innerText()).toContain("2 modifications pas encore diffusées : story-frame, DESIGN.md");
  expect(await tab.getByRole("button", { name: /Diffuser aux projets/ }).innerText()).toContain("2");

  const cards = tab.getByTestId("ds-page");
  expect(await cards.count()).toBe(2);
  expect(await cards.nth(1).innerText()).toContain("1 non diffusé");
  expect(await cards.nth(1).innerText()).toContain("1 composant · story-frame");
  expect(await cards.nth(0).innerText()).not.toContain("non diffusé");

  const rows = tab.getByTestId("diffusion-row");
  expect(await rows.count()).toBe(2);
  expect(await rows.nth(0).innerText()).toContain("Diffusion 2");
  expect(await rows.nth(0).innerText()).toContain("en cours");
  expect(await rows.nth(0).innerText()).toContain("1 composant ajouté : story-frame");
  expect(await rows.nth(1).innerText()).toContain("Diffusion 1");
  expect(await rows.nth(1).innerText()).toContain("Version initiale");

  expect(await tab.getByRole("heading", { name: "Utilisé par 2 projets" }).count()).toBe(1);
  expect(await tab.getByTestId("ds-user").first().innerText()).toContain("1 variable surchargée");
  expect(await tab.getByTestId("ds-user").nth(1).innerText()).toContain("Aucune surcharge");
  expect(await tab.getByText("Le logo jamais sur fond orange").count()).toBe(1);

  await cards.nth(1).click();
  await tab.waitForURL(`**/#/pages/${social.id}`);
  await tab.close();
});

it("creates a page of the design system from Nouvelle page", async () => {
  const { ds } = await seed();
  const tab = await browser.newPage({ viewport: { width: 1440, height: 1100 } });
  await tab.goto(`${server.url}/#/design-systems/${ds.id}`);
  await tab.getByRole("button", { name: "Nouvelle page" }).click();
  await tab.getByLabel("Nom de la page").fill("Formulaires");
  await tab.getByRole("button", { name: "Créer la page" }).click();
  await tab.waitForURL("**/#/pages/*");
  const pages = (await (await server.get(`/api/projects/${ds.id}/pages`)).json()) as Page[];
  expect(pages.map((p) => p.title)).toContain("Formulaires");
  await tab.close();
});

it("opens the diffusion dialog from the banner and the header, and the DESIGN.md editor from Modifier", async () => {
  const { ds } = await seed();
  const tab = await browser.newPage({ viewport: { width: 1440, height: 1100 } });
  await tab.goto(`${server.url}/#/design-systems/${ds.id}`);
  await tab.getByRole("button", { name: "Diffuser…" }).click();
  await tab.getByText(/^Diffuser la version 3 de Lumora$/).waitFor();
  await tab.keyboard.press("Escape");
  await tab.getByRole("link", { name: "Modifier" }).click();
  await tab.waitForURL(`**/#/projects/${ds.id}/design-md`);
  const back = `#/design-systems/${ds.id}`;
  await expect.poll(() => tab.getByRole("link", { name: "Fermer" }).getAttribute("href")).toBe(back);  expect(await tab.getByRole("navigation", { name: "Fil d'Ariane" }).getByRole("link", { name: "Lumora" }).getAttribute("href")).toBe(back);
  await tab.close();
}, 60_000);
