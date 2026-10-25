import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { build } from "vite";
import { chromium, type Browser } from "playwright";
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
  browser = await chromium.launch();
}, 60_000);

afterAll(async () => {
  await browser?.close();
  await server?.stop();
  rmSync(webDir, { recursive: true, force: true });
});

const tokensCss = (primary: string) => `:root {\n${CORE_TOKENS.map((t) => `  ${t}: ${t === "--color-primary" ? primary : "#000000"};`).join("\n")}\n}\n`;
const component = (css: string) => `<!doctype html><html><head><style data-component>${css}</style></head><body><div class="card">Hi</div></body></html>`;
const manifestOf = (files: string[], designSystem?: string) =>
  JSON.stringify({ ...(designSystem && { designSystem }), artboards: files.map((file, i) => ({ file, x: i * 300, y: 0, width: 200, height: 100 })) });

it("previews a project with the pending version: banner, read-only, diffuse from the banner, close", async () => {
  const ds = (await (await server.post("/api/design-systems", {
    title: "Lumora",
    files: { "tokens.css": tokensCss("#111111"), "manifest.json": manifestOf(["components/card.html"]), "components/card.html": component(".card{color:red}") },
  })).json()) as DesignSystem;
  const project = (await (await server.post("/api/projects", { title: "Semaine Halloween", designSystem: ds.id })).json()) as { id: string };
  const projectPage = (await (await server.post(`/api/projects/${project.id}/pages`, {
    title: "Stories",
    files: { "index.html": "<!doctype html><html><head></head><body>Hi</body></html>", "manifest.json": manifestOf(["index.html"], ds.id) },
  })).json()) as Page;
  const dsPage = ((await (await server.get(`/api/projects/${ds.id}/pages`)).json()) as Page[])[0]!;
  await server.post(`/api/pages/${dsPage.id}/versions`, {
    files: { "tokens.css": tokensCss("#222222"), "manifest.json": manifestOf(["components/card.html", "components/badge.html"]), "components/card.html": component(".card{color:blue}"), "components/badge.html": component(".badge{color:green}") },
    message: "Edit",
    origin: "thread",
  });

  const context = await browser.newContext();
  context.setDefaultTimeout(15_000);
  const tab = await context.newPage();
  await tab.goto(`${server.url}/#/pages/${dsPage.id}`);
  await tab.getByRole("button", { name: /Diffuser aux projets/ }).click();
  const dialog = tab.getByRole("dialog", { name: "Diffuser la version 2 de Lumora" });
  await dialog.waitFor();

  const [preview] = await Promise.all([context.waitForEvent("page"), dialog.getByRole("button", { name: /Ouvrir l'aperçu/ }).click()]);
  const banner = preview.getByRole("region", { name: "Aperçu" });
  await banner.waitFor();
  await expect.poll(async () => banner.textContent()).toContain("Aperçu avec la version non diffusée de Lumora · 1 token, 2 composants · visible par toi seul");
  expect(preview.url()).toContain(`#/pages/${projectPage.id}?apercu=${ds.id}`);

  // The artboard is served with the draft, and nothing can be commented, discussed or saved.
  const frame = preview.locator("iframe").first();
  await expect.poll(async () => frame.getAttribute("src")).toContain("preview=draft");
  expect(await preview.getByText("Commentaires et conversations désactivés pendant l'aperçu").count()).toBe(1);
  expect(await preview.getByRole("complementary").count()).toBe(0);
  expect(await preview.getByRole("group", { name: "Mode du canvas" }).count()).toBe(0);
  expect(await preview.getByRole("button", { name: /Commenter tout/ }).count()).toBe(0);
  expect(await preview.getByRole("button", { name: "Tweaks" }).count()).toBe(0);

  // The normal route of the same page keeps the current diffusion and has no banner.
  await tab.close();
  const normal = await context.newPage();
  await normal.goto(`${server.url}/#/pages/${projectPage.id}`);
  await normal.getByRole("group", { name: "Mode du canvas" }).waitFor();
  expect(await normal.getByRole("region", { name: "Aperçu" }).count()).toBe(0);
  expect(await normal.locator("iframe").first().getAttribute("src")).not.toContain("preview=draft");
  await normal.close();

  // Diffuser from the banner diffuses.
  await banner.getByRole("button", { name: "Diffuser", exact: true }).click();
  await preview.getByRole("dialog", { name: "Diffuser la version 2 de Lumora" }).getByRole("button", { name: "Diffuser", exact: true }).click();
  await expect.poll(async () => preview.getByTestId("diffusion-toast").textContent()).toBe("Diffusion 2 envoyée à 1 projet");
  expect(((await (await server.get(`/api/design-systems/${ds.id}`)).json()) as DesignSystemDetail).current.number).toBe(2);

  // Fermer l'aperçu closes the tab.
  await banner.getByRole("button", { name: "Fermer l'aperçu" }).click();
  await expect.poll(() => preview.isClosed()).toBe(true);
  await context.close();
}, 90_000);
