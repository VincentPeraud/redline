import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { copyBuiltWeb } from "./builtWeb.js";
import { type Browser } from "playwright";
import { launchBrowser } from "./journeyBrowser.js";
import { afterAll, beforeAll, expect, it } from "vitest";
import { CORE_TOKENS, type DesignSystem, type Project, type ProjectDesignSystem } from "@redline/shared";
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
const manifestOf = (files: string[]) => JSON.stringify({ artboards: files.map((file, i) => ({ file, x: i * 300, y: 0, width: 200, height: 100 })) });
const component = `<!doctype html><html><head><style data-component>.cta{color:red}</style></head><body></body></html>`;

async function seed() {
  const ds = (await (await server.post("/api/design-systems", { title: "Lumora", files: { "tokens.css": tokensCss(), "manifest.json": manifestOf(["components/post-cta.html"]), "components/post-cta.html": component } })).json()) as DesignSystem;
  const project = (await (await server.post("/api/projects", { title: "Semaine Halloween", designSystem: ds.id })).json()) as Project;
  return { ds, project };
}
const detail = async (project: Project) => (await (await server.get(`/api/projects/${project.id}/design-system`)).json()) as ProjectDesignSystem;

it("shows the Ce projet suit line in its four states and compares the variables with the draft", async () => {
  const { ds, project } = await seed();
  const tab = await browser.newPage({ viewport: { width: 1440, height: 900 } });
  await tab.goto(`${server.url}/#/projects/${project.id}/design-system`);
  const status = tab.getByTestId("follow-status");

  // Latest diffusion (default).
  await status.waitFor();
  expect(await status.textContent()).toBe("Les pages voient Lumora tel qu'il a été diffusé. Les modifications en cours n'arrivent qu'à la prochaine diffusion.");
  expect(await tab.getByText(/^Diffusion 1 du/).count()).toBe(1);

  // Draft identical to the diffusion.
  await tab.getByRole("radio", { name: "Le brouillon" }).click();
  await tab.getByText("Le brouillon est identique à la diffusion 1 : rien de plus pour l'instant.").waitFor();
  expect(await tab.getByRole("radio", { name: "Le brouillon" }).getAttribute("aria-checked")).toBe("true");
  expect(await tab.getByText(/^Brouillon de Lumora ·/).count()).toBe(1);
  expect((await detail(project)).followsDraft).toBe(true);
  await tab.getByRole("radio", { name: "La dernière diffusion" }).click();
  await tab.getByText("Les pages voient Lumora").waitFor();

  // Draft ahead of the diffusion: a new token and the count.
  await server.post(`/api/pages/${ds.pageId}/versions`, { files: { "tokens.css": tokensCss("  --color-chip-bg: #e6f2f1;\n"), "manifest.json": manifestOf(["components/post-cta.html"]), "components/post-cta.html": component }, message: "Chip", origin: "thread" });
  await tab.reload();
  await tab.getByRole("radio", { name: "Le brouillon" }).click();
  await tab.getByText(/pas encore diffusée?s?/).waitFor();
  expect(await status.textContent()).toMatch(/^\d+ modifications? pas encore diffusées? (est|sont) déjà visibles? dans ce projet, et ses pages se publient avec elles?\.$/);
  const row = tab.getByTestId("token---color-chip-bg");
  expect(await row.textContent()).toContain("nouveau dans le brouillon");
  expect(await tab.getByText("Lumora · brouillon").count()).toBe(1);
  await tab.close();
});

it("keeps the previous setting and offers to retry when the save fails", async () => {
  const { project } = await seed();
  const tab = await browser.newPage({ viewport: { width: 1440, height: 900 } });
  let fail = true;
  await tab.route(`**/api/projects/${project.id}/design-system`, (route) => (fail && route.request().method() === "PUT" ? route.abort("connectionreset") : route.continue()));
  await tab.goto(`${server.url}/#/projects/${project.id}/design-system`);
  await tab.getByRole("radio", { name: "Le brouillon" }).click();
  await tab.getByText("Le changement n'a pas été enregistré (connexion perdue). Le projet suit toujours la dernière diffusion.").waitFor();
  expect(await tab.getByRole("radio", { name: "La dernière diffusion" }).getAttribute("aria-checked")).toBe("true");
  expect((await detail(project)).followsDraft).toBe(false);
  fail = false;
  await tab.getByRole("button", { name: "Réessayer" }).click();
  await tab.getByText(/Le brouillon est identique/).waitFor();
  expect((await detail(project)).followsDraft).toBe(true);
  await tab.close();
});

it("hides the line without a shared design system and disables it for a member without Écriture", async () => {
  const { project } = await seed();
  const none = (await (await server.post("/api/projects", { title: "Libre" })).json()) as Project;
  const tab = await browser.newPage({ viewport: { width: 1440, height: 900 } });
  await tab.goto(`${server.url}/#/projects/${none.id}/design-system`);
  await tab.getByText("Variables").waitFor();
  expect(await tab.getByText("Ce projet suit").count()).toBe(0);

  await tab.route(`**/api/projects/${project.id}`, async (route) => {
    const response = await route.fetch();
    await route.fulfill({ response, json: { ...((await response.json()) as object), viewerLevel: "read" } });
  });
  await tab.goto(`${server.url}/#/projects/${project.id}/design-system`);
  await tab.getByRole("radio", { name: "Le brouillon" }).waitFor();
  expect(await tab.getByRole("radio", { name: "Le brouillon" }).isDisabled()).toBe(true);
  await tab.close();
});
