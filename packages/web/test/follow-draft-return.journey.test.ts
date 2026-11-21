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

/** The draft adds ui-badge and --chip; a project on the draft uses both when `broken`. */
async function seed(title: string, broken = true) {
  const ds = (await (await server.post("/api/design-systems", { title, files: { "tokens.css": tokensCss(), "manifest.json": manifestOf([]) } })).json()) as DesignSystem;
  await server.post(`/api/pages/${ds.pageId}/versions`, { files: { "tokens.css": tokensCss("  --chip: #eee;\n"), "manifest.json": manifestOf(["components/badge.html"]), "components/badge.html": component }, message: "Add", origin: "thread" });
  const project = (await (await server.post("/api/projects", { title: "App", designSystem: ds.id })).json()) as Project;
  await server.post("/api/projects", { title: "Site public", designSystem: ds.id });
  await put(project, { followsDraft: true });
  const page = (await (await server.post(`/api/projects/${project.id}/pages`, {
    title: "Authentification",
    files: {
      "manifest.json": manifestOf(["a.html", "b.html"], ds.id),
      "a.html": `<!doctype html><html><head></head><body>${broken ? "<ui-badge>x</ui-badge><ui-badge>y</ui-badge>" : "<p>plain</p>"}</body></html>`,
      "b.html": `<!doctype html><html><head></head><body>${broken ? '<i style="color:var(--chip)"></i>' : "<p>plain</p>"}</body></html>`,
    },
  })).json()) as Page;
  return { ds, project, page };
}
const put = (project: Project, body: unknown) =>
  fetch(`${server.url}/api/projects/${project.id}/design-system`, { method: "PUT", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
const detail = async (project: Project) => (await (await server.get(`/api/projects/${project.id}/design-system`)).json()) as ProjectDesignSystem;
const open = async (project: Project) => {
  const tab = await browser.newPage({ viewport: { width: 1440, height: 900 } });
  await tab.goto(`${server.url}/#/projects/${project.id}/design-system`);
  await tab.getByRole("radio", { name: "La dernière diffusion" }).click();
  return tab;
};

it("asks before going back, lists the broken pages, and switches and opens the thread on confirmation", async () => {
  const { project, page } = await seed("Locoum");
  const tab = await open(project);
  const dialog = tab.getByRole("dialog", { name: "Revenir à la dernière diffusion ?" });
  await dialog.waitFor();
  await dialog.getByText("1 page utilise des éléments absents de la diffusion 1.").waitFor();
  const text = (await dialog.getByTestId("broken-Authentification").textContent())!;
  expect(text).toContain("ui-badge · composant absent : la page ne pourra plus être publiée tant qu'il n'est pas diffusé");
  expect(text).toContain("Connexion · 2 instances");
  expect(text).toContain("--chip · variable absente : s'affiche sans elle");
  expect(text).toContain("Compte créé");
  expect(await dialog.textContent()).toContain("la diffusion part aussi vers Site public");
  expect((await detail(project)).followsDraft).toBe(true);

  await dialog.getByRole("button", { name: "Annuler" }).click();
  await dialog.waitFor({ state: "detached" });
  expect((await detail(project)).followsDraft).toBe(true);

  // Revenir quand même, with an error first: the dialog stays and the project keeps the draft.
  let fail = true;
  await tab.route(`**/api/projects/${project.id}/design-system`, (route) => (fail && route.request().method() === "PUT" && route.request().postData()?.includes("confirm") ? route.abort("connectionreset") : route.continue()));
  await tab.getByRole("radio", { name: "La dernière diffusion" }).click();
  await dialog.waitFor();
  await dialog.getByRole("button", { name: "Revenir quand même" }).waitFor();
  await dialog.getByRole("button", { name: "Revenir quand même" }).click();
  await dialog.getByText("Le changement n'a pas été enregistré (connexion perdue). Le projet suit toujours le brouillon.").waitFor();
  expect((await detail(project)).followsDraft).toBe(true);

  fail = false;
  await dialog.getByRole("button", { name: "Revenir quand même" }).click();
  await dialog.waitFor({ state: "detached" });
  await tab.getByText(/^Diffusion 1 du/).waitFor();
  expect((await detail(project)).followsDraft).toBe(false);
  const threads = (await (await server.get(`/api/pages/${page.id}/threads`)).json()) as Thread[];
  expect(threads.map((t) => t.title)).toEqual(["Retour à la dernière diffusion"]);
  await tab.close();
});

it("shows a simple confirmation when no page breaks, waiting while the pages are computed", async () => {
  const { project } = await seed("Quiet", false);
  const tab = await browser.newPage({ viewport: { width: 1440, height: 900 } });
  let release: () => void = () => {};
  const gate = new Promise<void>((resolve) => (release = resolve));
  await tab.route(`**/api/projects/${project.id}/design-system`, async (route) => {
    if (route.request().method() === "PUT") await gate;
    await route.continue();
  });
  await tab.goto(`${server.url}/#/projects/${project.id}/design-system`);
  await tab.getByRole("radio", { name: "La dernière diffusion" }).click();
  const dialog = tab.getByRole("dialog", { name: "Revenir à la dernière diffusion ?" });
  await dialog.waitFor();
  expect(await dialog.getByRole("button", { name: "Revenir à la diffusion 1" }).isDisabled()).toBe(true);
  release();
  await dialog.getByText("Aucune page ne se casse.", { exact: false }).waitFor();
  expect(await dialog.getByRole("button", { name: "Diffuser d'abord" }).count()).toBe(0);
  await dialog.getByRole("button", { name: "Revenir à la diffusion 1" }).click();
  await dialog.waitFor({ state: "detached" });
  await tab.getByText(/^Diffusion 1 du/).waitFor();
  expect((await detail(project)).followsDraft).toBe(false);
  await tab.close();
});

it("Diffuser d'abord opens the diffusion review, and the project goes back once it diffuses", async () => {
  const { project } = await seed("Diffuse");
  const tab = await open(project);
  const dialog = tab.getByRole("dialog", { name: "Revenir à la dernière diffusion ?" });
  await dialog.getByRole("button", { name: "Diffuser d'abord" }).click();
  const review = tab.getByRole("dialog", { name: /^Diffuser la version 2/ });
  await review.waitFor();
  await review.getByRole("button", { name: "Diffuser", exact: true }).click();
  await review.waitFor({ state: "detached" });
  await tab.getByText(/^Diffusion 2 du/).waitFor();
  expect((await detail(project)).followsDraft).toBe(false);
  await tab.close();
});

it("closing the review without diffusing keeps the project on the draft", async () => {
  const { ds, project } = await seed("Dropped");
  const tab = await open(project);
  await tab.getByRole("dialog", { name: "Revenir à la dernière diffusion ?" }).getByRole("button", { name: "Diffuser d'abord" }).click();
  const review = tab.getByRole("dialog", { name: /^Diffuser la version 2/ });
  await review.waitFor();
  await review.getByRole("button", { name: "Annuler" }).click();
  await review.waitFor({ state: "detached" });
  await server.post(`/api/design-systems/${ds.id}/diffusions`, {});
  expect((await detail(project)).followsDraft).toBe(true);
  await tab.close();
});

it("hides Diffuser d'abord from a member who cannot diffuse", async () => {
  const { project } = await seed("Locked");
  const tab = await browser.newPage({ viewport: { width: 1440, height: 900 } });
  await tab.route(`**/api/projects/${project.id}/design-system`, async (route) => {
    if (route.request().method() !== "PUT") return route.continue();
    const real = await route.fetch();
    await route.fulfill({ response: real, json: { ...((await real.json()) as object), canDiffuse: false } });
  });
  await tab.goto(`${server.url}/#/projects/${project.id}/design-system`);
  await tab.getByRole("radio", { name: "La dernière diffusion" }).click();
  const dialog = tab.getByRole("dialog", { name: "Revenir à la dernière diffusion ?" });
  await dialog.getByRole("button", { name: "Revenir quand même" }).waitFor();
  expect(await dialog.getByRole("button", { name: "Diffuser d'abord" }).count()).toBe(0);
  expect(await dialog.textContent()).not.toContain("Diffuser d'abord");
  await tab.close();
});
