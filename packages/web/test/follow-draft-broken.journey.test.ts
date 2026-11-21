import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { copyBuiltWeb } from "./builtWeb.js";
import { type Browser } from "playwright";
import { launchBrowser } from "./journeyBrowser.js";
import { afterAll, beforeAll, expect, it } from "vitest";
import { CORE_TOKENS, type DesignSystem, type Page, type Project, type ProjectDesignSystem, type Thread } from "@redline/shared";
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

const tokensCss = (extra = "") => `:root {\n${CORE_TOKENS.map((t) => `  ${t}: #112233;`).join("\n")}\n${extra}}\n`;
const manifestOf = (files: string[], designSystem?: string) =>
  JSON.stringify({ ...(designSystem && { designSystem }), artboards: files.map((file, i) => ({ file, title: i === 0 ? "Connexion" : "Compte créé", x: i * 300, y: 0, width: 200, height: 100 })) });
const component = `<!doctype html><html><head></head><body><template data-component><span><slot></slot></span></template></body></html>`;

async function seed(title: string, broken = true) {
  const ds = (await (await server.post("/api/design-systems", { title, files: { "tokens.css": tokensCss("  --color-accent-soft: #eee;\n"), "manifest.json": manifestOf(["components/badge.html"]), "components/badge.html": component } })).json()) as DesignSystem;
  await server.post(`/api/pages/${ds.pageId}/versions`, { files: { "tokens.css": tokensCss("  --color-accent-subtle: #eee;\n"), "manifest.json": manifestOf([]) }, message: "Remove", origin: "thread", confirmRemovals: true });
  const project = (await (await server.post("/api/projects", { title: "App", designSystem: ds.id })).json()) as Project;
  const page = (await (await server.post(`/api/projects/${project.id}/pages`, {
    title: "Authentification",
    files: {
      "manifest.json": manifestOf(["a.html", "b.html"], ds.id),
      "a.html": `<!doctype html><html><head></head><body>${broken ? "<ui-badge>x</ui-badge><ui-badge>y</ui-badge>" : "<p>plain</p>"}</body></html>`,
      "b.html": `<!doctype html><html><head></head><body>${broken ? '<i style="color:var(--color-accent-soft)"></i>' : "<p>plain</p>"}</body></html>`,
    },
  })).json()) as Page;
  return { project, page };
}
const detail = async (project: Project) => (await (await server.get(`/api/projects/${project.id}/design-system`)).json()) as ProjectDesignSystem;

it("asks before turning on a draft that breaks a page, and switches and opens the thread on confirmation", async () => {
  const { project, page } = await seed("Locoum");
  const tab = await browser.newPage({ viewport: { width: 1440, height: 900 } });
  await tab.goto(`${server.url}/#/projects/${project.id}/design-system`);
  await tab.getByRole("radio", { name: "Le brouillon" }).click();

  const dialog = tab.getByRole("dialog", { name: "Passer sur le brouillon de Locoum ?" });
  await dialog.waitFor();
  const row = dialog.getByTestId("broken-Authentification");
  const text = (await row.textContent())!;
  expect(text).toContain("ui-badge · composant retiré du brouillon : la page ne pourra plus être publiée tant qu'elle l'utilise");
  expect(text).toContain("Connexion · 2 instances");
  expect(text).toContain("--color-accent-soft · variable renommée en --color-accent-subtle : s'affiche sans elle");
  expect(text).toContain("Compte créé");
  expect((await detail(project)).followsDraft).toBe(false);

  // Annuler changes nothing.
  await dialog.getByRole("button", { name: "Annuler" }).click();
  await dialog.waitFor({ state: "detached" });
  expect((await detail(project)).followsDraft).toBe(false);
  expect(((await (await server.get(`/api/pages/${page.id}/threads`)).json()) as Thread[]).length).toBe(0);

  // Passer quand même, with an error first: the dialog stays and the diffusion is kept.
  let fail = true;
  await tab.route(`**/api/projects/${project.id}/design-system`, (route) => (fail && route.request().method() === "PUT" && route.request().postData()?.includes("confirm") ? route.abort("connectionreset") : route.continue()));
  await tab.getByRole("radio", { name: "Le brouillon" }).click();
  await dialog.waitFor();
  await dialog.getByRole("button", { name: "Passer quand même" }).click();
  await dialog.getByText("Le changement n'a pas été enregistré (connexion perdue). Le projet suit toujours la dernière diffusion.").waitFor();
  expect((await detail(project)).followsDraft).toBe(false);

  fail = false;
  await dialog.getByRole("button", { name: "Passer quand même" }).click();
  await dialog.waitFor({ state: "detached" });
  await tab.getByText(/^Brouillon de Locoum ·/).waitFor();
  expect((await detail(project)).followsDraft).toBe(true);
  const threads = (await (await server.get(`/api/pages/${page.id}/threads`)).json()) as Thread[];
  expect(threads.map((t) => t.title)).toEqual(["Retrait dans le design system"]);
  await tab.close();
});

it("turns the draft on at once when no page breaks", async () => {
  const { project } = await seed("Quiet", false);
  const tab = await browser.newPage({ viewport: { width: 1440, height: 900 } });
  await tab.goto(`${server.url}/#/projects/${project.id}/design-system`);
  await tab.getByRole("radio", { name: "Le brouillon" }).click();
  await tab.getByText(/^Brouillon de Quiet ·/).waitFor();
  expect(await tab.getByRole("dialog").count()).toBe(0);
  await tab.close();
});
