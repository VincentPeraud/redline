import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { build } from "vite";
import { chromium, type Browser } from "playwright";
import { afterAll, beforeAll, expect, it } from "vitest";
import { CORE_TOKENS, type DesignSystem, type Project, type ProjectDesignSystem } from "@redline/shared";
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

const tokensCss = `:root {\n${CORE_TOKENS.map((t) => `  ${t}: ${t === "--font-heading" ? "Poppins" : t === "--radius" ? "12px" : "#f25c2a"};`).join("\n")}\n  --color-accent: var(--color-primary); /* deprecated: renamed to --color-highlight */\n}\n`;
const component = (css: string) => `<!doctype html><html><head><style data-component>${css}</style></head><body></body></html>`;
const manifestOf = (files: string[]) => JSON.stringify({ artboards: files.map((file, i) => ({ file, x: i * 300, y: 0, width: 200, height: 100 })) });

async function seed() {
  const ds = (await (await server.post("/api/design-systems", {
    title: "Lumora",
    files: {
      "tokens.css": tokensCss,
      "manifest.json": manifestOf(["components/post-cta.html"]),
      "components/post-cta.html": component(".cta{color:red}"),
    },
  })).json()) as DesignSystem;
  const project = (await (await server.post("/api/projects", { title: "Semaine Halloween", designSystem: ds.id })).json()) as Project;
  await server.post(`/api/projects/${project.id}/pages`, {
    title: "Stories",
    files: {
      "manifest.json": manifestOf(["components/sticker-citrouille.html", "components/post-cta.html"]),
      "components/sticker-citrouille.html": component(".s{}"),
      "components/post-cta.html": component(".cta{color:purple}"),
    },
  });
  return { ds, project };
}

const detail = async (project: Project) => (await (await server.get(`/api/projects/${project.id}/design-system`)).json()) as ProjectDesignSystem;

it("overrides a token with a text field and the colour picker, resets it, and lists project components", async () => {
  const { project } = await seed();
  const tab = await browser.newPage({ viewport: { width: 1440, height: 1100 } });
  await tab.goto(`${server.url}/#/projects/${project.id}/design-system`);

  const row = (name: string) => tab.getByTestId(`token-${name}`);
  await row("--radius").waitFor();
  expect(await row("--radius").textContent()).toContain("Valeur de Lumora");
  expect(await tab.getByText("Diffusion 1 du").textContent()).toContain("ouvrir Lumora");
  expect(await row("--color-accent").textContent()).toContain("déprécié");

  // Text field: "Surcharger" starts an override with the design system value, then the field edits it.
  await row("--radius").getByRole("button", { name: "Surcharger" }).click();
  await expect.poll(async () => (await detail(project)).overrideCount).toBe(1);
  await expect.poll(() => row("--radius").textContent()).toContain("surchargée");
  await row("--radius").getByLabel("Valeur de --radius").fill("20px");
  await row("--radius").getByLabel("Valeur de --radius").blur();
  await expect.poll(async () => (await detail(project)).tokens.find((t) => t.name === "--radius")?.projectValue).toBe("20px");

  // Colour picker.
  await row("--color-primary").getByRole("button", { name: "Surcharger" }).click();
  await expect.poll(async () => (await detail(project)).overrideCount).toBe(2);
  await row("--color-primary").getByLabel("Couleur de --color-primary").fill("#8b5cf6");
  await expect.poll(async () => (await detail(project)).tokens.find((t) => t.name === "--color-primary")?.projectValue).toBe("#8b5cf6");
  await tab.getByText("2 surchargées").waitFor();

  // Components with their badges.
  expect(await tab.getByText("Composants du projet · 2").count()).toBe(1);
  expect(await tab.getByRole("link", { name: /sticker-citrouille/ }).textContent()).toContain("nouveau");
  expect(await tab.getByRole("link", { name: /post-cta/ }).textContent()).toContain("surchargé");

  // Reset with the arrow.
  await row("--radius").getByRole("button", { name: "Revenir à la valeur de Lumora pour --radius" }).click();
  await expect.poll(async () => (await detail(project)).overrideCount).toBe(1);
  await expect.poll(() => row("--radius").textContent()).toContain("Valeur de Lumora");

  // History lists the user versions.
  await tab.getByRole("button", { name: "Historique" }).click();
  await tab.getByRole("dialog", { name: "Historique du style du projet" }).waitFor();
  await tab.keyboard.press("Escape");
  await tab.close();
});

it("shows the counts in the overview box and links to the page", async () => {
  const { project } = await seed();
  await fetch(`${server.url}/api/projects/${project.id}/project-style/tokens/--radius`, {
    method: "PUT",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ value: "20px" }),
  });
  const tab = await browser.newPage({ viewport: { width: 1440, height: 1100 } });
  await tab.goto(`${server.url}/#/projects/${project.id}`);
  const box = tab.getByRole("link", { name: /Lumora/ }).filter({ hasText: "composants du projet" });
  await box.waitFor();
  expect(await box.textContent()).toContain("diffusion 1");
  expect(await box.textContent()).toContain("1 variable surchargée");
  expect(await box.textContent()).toContain("2 composants du projet");
  await tab.getByRole("link", { name: "Modifier" }).first().click();
  await tab.getByRole("heading", { name: "Variables" }).waitFor();
  await tab.close();
});

it("lists the whole style of a project without a shared design system", async () => {
  const project = (await (await server.post("/api/projects", { title: "Solo" })).json()) as Project;
  const tab = await browser.newPage({ viewport: { width: 1440, height: 1100 } });
  await tab.goto(`${server.url}/#/projects/${project.id}/design-system`);
  await tab.getByTestId("token---color-primary").waitFor();
  expect(await tab.getByText("Ce style n'est pas partagé").count()).toBe(1);
  await tab.getByTestId("token---color-primary").getByLabel("Valeur de --color-primary").fill("#ff7a00");
  await tab.getByTestId("token---color-primary").getByLabel("Valeur de --color-primary").blur();
  await expect.poll(async () => (await detail(project)).tokens.find((t) => t.name === "--color-primary")?.value).toBe("#ff7a00");
  await tab.goto(`${server.url}/#/projects/${project.id}`);
  await tab.getByText("Pas de design system partagé").waitFor();
  await tab.close();
});
