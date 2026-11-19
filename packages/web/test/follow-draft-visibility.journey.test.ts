import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { copyBuiltWeb } from "./builtWeb.js";
import { type Browser } from "playwright";
import { launchBrowser } from "./journeyBrowser.js";
import { afterAll, beforeAll, expect, it } from "vitest";
import { CORE_TOKENS, type DesignSystem, type Project } from "@redline/shared";
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
const card = (css: string) => `<!doctype html><html><head></head><body><template data-component><div class="card"><slot></slot></div></template><style data-component>${css}</style></body></html>`;
const manifestOf = (files: string[], designSystem?: string) => JSON.stringify({ ...(designSystem && { designSystem }), artboards: files.map((file, i) => ({ file, x: i * 300, y: 0, width: 200, height: 100 })) });
const put = (path: string, body: unknown) => fetch(server.url + path, { method: "PUT", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });

async function seed() {
  const ds = (await (await server.post("/api/design-systems", { title: "Lumora", files: { "tokens.css": tokensCss("#111111"), "manifest.json": manifestOf(["components/card.html"]), "components/card.html": card(".card{color:red}") } })).json()) as DesignSystem;
  const app = (await (await server.post("/api/projects", { title: "Lumora App", designSystem: ds.id })).json()) as Project;
  const site = (await (await server.post("/api/projects", { title: "Site public", designSystem: ds.id })).json()) as Project;
  await server.post(`/api/projects/${app.id}/pages`, { title: "Flow", files: { "manifest.json": manifestOf(["a.html"], ds.id), "a.html": "<!doctype html><html><head></head><body><ui-card>x</ui-card></body></html>" } });
  await server.post(`/api/projects/${site.id}/pages`, { title: "Home", files: { "manifest.json": manifestOf(["a.html"], ds.id), "a.html": "<!doctype html><html><head></head><body><ui-card>x</ui-card></body></html>" } });
  return { ds, app, site };
}
const draftWork = (ds: DesignSystem) =>
  server.post(`/api/pages/${ds.pageId}/versions`, { files: { "tokens.css": tokensCss("#ff6600"), "manifest.json": manifestOf(["components/card.html"]), "components/card.html": card(".card{color:blue}") }, message: "Edit", origin: "thread" });

it("shows the project overview card for a project on the draft, with swatches from the draft", async () => {
  const { ds, app } = await seed();
  const tab = await browser.newPage({ viewport: { width: 1440, height: 900 } });
  await tab.goto(`${server.url}/#/projects/${app.id}`);
  await tab.getByText("Lumora", { exact: true }).first().waitFor();
  expect(await tab.getByText("suit le brouillon").count()).toBe(0);
  expect(await tab.getByText("diffusion 1", { exact: true }).count()).toBe(1);

  await put(`/api/projects/${app.id}/design-system`, { followsDraft: true });
  await tab.reload();
  await tab.getByText("suit le brouillon").waitFor();
  expect(await tab.getByText("À jour avec la diffusion 1").count()).toBe(1);

  await draftWork(ds);
  await tab.reload();
  await tab.getByText(/pas encore diffusées?, déjà visibles? ici · dernière diffusion : 1$/).waitFor();
  expect(await tab.getByText("À jour avec la diffusion 1").count()).toBe(0);
  const first = tab.locator("a[href*='design-system'] div[aria-hidden='true'] > div").first();
  expect(await first.evaluate((el) => getComputedStyle(el).backgroundColor)).toBe("rgb(255, 102, 0)");
  await tab.close();
});

it("shows on the design system overview who follows the draft, in the band, the header and the review", async () => {
  const { ds, app } = await seed();
  await draftWork(ds);
  const tab = await browser.newPage({ viewport: { width: 1440, height: 1000 } });
  await tab.goto(`${server.url}/#/design-systems/${ds.id}`);
  await tab.getByRole("heading", { name: "Lumora", level: 1 }).waitFor();
  expect(await tab.getByRole("heading", { name: /^Utilisé par 2 projets/ }).innerText()).toBe("Utilisé par 2 projets");
  expect(await tab.getByText("Déjà visibles dans").count()).toBe(0);
  expect(await tab.getByTestId("ds-user").filter({ hasText: "diffusion 1" }).count()).toBe(2);

  await put(`/api/projects/${app.id}/design-system`, { followsDraft: true });
  await tab.reload();
  await tab.getByRole("heading", { name: /^Utilisé par 2 projets/ }).waitFor();
  expect(await tab.getByRole("heading", { name: /^Utilisé par 2 projets/ }).innerText()).toBe("Utilisé par 2 projets · 1 sur le brouillon");
  const follower = tab.getByTestId("ds-user").filter({ hasText: "Lumora App" });
  expect(await follower.innerText()).toContain("suit le brouillon");
  expect(await follower.innerText()).toContain("voit les modifications en cours");
  const other = tab.getByTestId("ds-user").filter({ hasText: "Site public" });
  expect(await other.innerText()).not.toContain("suit le brouillon");
  expect(await other.innerText()).toContain("diffusion 1");
  expect(await tab.getByTestId("pending-banner").innerText()).toMatch(/Déjà visibles? dans Lumora App, qui suit le brouillon\./);

  await tab.getByRole("button", { name: /Diffuser aux projets/ }).click();
  const dialog = tab.getByRole("dialog");
  const component = dialog.getByTestId("diffusion-component").filter({ hasText: "ui-card" });
  await component.waitFor();
  expect(await component.innerText()).toContain("déjà visible dans Lumora App");
  expect(await component.innerText()).not.toContain("Site public");
  await tab.keyboard.press("Escape");

  await tab.goto(`${server.url}/#/pages/${ds.pageId}`);
  const header = tab.getByRole("banner");
  await header.getByText("Publié ici, visible tout de suite dans Lumora App").waitFor();
  await put(`/api/projects/${app.id}/design-system`, { followsDraft: false, confirm: true });
  await tab.reload();
  await header.getByRole("link", { name: "Lumora" }).waitFor();
  expect(await header.getByText(/Publié ici/).count()).toBe(0);
  await tab.close();
});
