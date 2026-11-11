import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { copyBuiltWeb } from "./builtWeb.js";
import { type Browser } from "playwright";
import { launchBrowser } from "./journeyBrowser.js";
import { afterAll, beforeAll, expect, it } from "vitest";
import { CORE_TOKENS, type DesignSystem, type Project, type ProjectDesignSystem } from "@redline/shared";
import { startTestServer, type TestServer } from "@redline/server/test-harness";

const captures = process.env.MOVE_UP_CAPTURES;

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

const tokensCss = `:root {\n${CORE_TOKENS.map((t) => `  ${t}: #f25c2a;`).join("\n")}\n}\n`;
const componentFile = (name: string) =>
  `<!doctype html><html><head><style data-component>ui-${name}{display:block}</style></head><body><template data-component><div class="${name}"><slot></slot></div></template></body></html>`;
const manifestOf = (files: string[], designSystem?: string) =>
  JSON.stringify({ ...(designSystem && { designSystem }), artboards: files.map((file, i) => ({ file, x: i * 300, y: 0, width: 200, height: 100 })) });
const mockup = (body: string) => `<!doctype html><html><head></head><body>${body}</body></html>`;

const detail = async (project: Project) => (await (await server.get(`/api/projects/${project.id}/design-system`)).json()) as ProjectDesignSystem;

async function seed() {
  const ds = (await (await server.post("/api/design-systems", {
    title: "Lumora",
    files: { "tokens.css": tokensCss, "manifest.json": manifestOf(["components/modal.html"]), "components/modal.html": componentFile("modal") },
  })).json()) as DesignSystem;
  const project = (await (await server.post("/api/projects", { title: "App", designSystem: ds.id })).json()) as Project;
  await server.post(`/api/projects/${project.id}/pages`, {
    title: "Missions",
    files: {
      "manifest.json": manifestOf(["a.html", "components/mission-card.html", "components/slot-picker.html"], ds.id),
      "a.html": mockup(`${"<ui-mission-card>x</ui-mission-card>".repeat(8)}${"<ui-slot-picker>y</ui-slot-picker>".repeat(3)}`),
      "components/mission-card.html": componentFile("mission-card"),
      "components/slot-picker.html": componentFile("slot-picker"),
    },
  });
  return { ds, project };
}

it("moves a component up through the dialog, then the diffusion takes the project's copy away", async () => {
  const { ds, project } = await seed();
  const tab = await browser.newPage({ viewport: { width: 1440, height: 1100 } });
  await tab.goto(`${server.url}/#/projects/${project.id}/design-system`);
  const card = tab.getByTestId("component-mission-card");
  await card.waitFor();
  expect(await tab.locator("aside").textContent()).toContain("Les remonter les rend disponibles pour tous les projets.");

  // The card links to the component's artboard; its buttons are not inside the link.
  expect(await card.locator("a").getAttribute("href")).toContain("components%2Fmission-card.html");
  expect(await card.locator("a button").count()).toBe(0);

  await card.getByRole("button", { name: "Remonter au design system" }).click();
  const dialog = tab.getByRole("dialog", { name: "Remonter ui-mission-card" });
  await dialog.waitFor();
  expect(await dialog.textContent()).toContain("Le composant passe dans le brouillon de Lumora. Les 8 instances d'App ne changent pas et suivent désormais Lumora.");
  if (captures) await tab.waitForTimeout(400);
  if (captures) await tab.screenshot({ path: join(captures, "17-app-dialog.png") });
  await dialog.getByRole("button", { name: "Remonter", exact: true }).click();
  await dialog.waitFor({ state: "detached" });

  await expect.poll(async () => (await detail(project)).components.find((c) => c.name === "mission-card")?.movedUp).toBe(true);
  expect(await card.textContent()).toContain("Remonté : il passera dans Lumora à la prochaine diffusion.");
  expect(await card.getByRole("button").count()).toBe(0);

  await server.post(`/api/design-systems/${ds.id}/diffusions`, {});
  await tab.reload();
  await tab.getByTestId("component-slot-picker").waitFor();
  expect(await tab.getByTestId("component-mission-card").count()).toBe(0);
  await tab.close();
});

it("flags a homonym the design system diffused and switches to the design system's component", async () => {
  const { ds, project } = await seed();
  await server.post(`/api/pages/${ds.pageId}/versions`, {
    files: {
      "manifest.json": manifestOf(["components/modal.html", "components/slot-picker.html"]),
      "components/modal.html": componentFile("modal"),
      "components/slot-picker.html": componentFile("slot-picker"),
    },
    message: "Add slot-picker",
    origin: "thread",
  });
  await server.post(`/api/design-systems/${ds.id}/diffusions`, {});

  const tab = await browser.newPage({ viewport: { width: 1440, height: 1100 } });
  await tab.goto(`${server.url}/#/projects/${project.id}/design-system`);
  const card = tab.getByTestId("component-slot-picker");
  await card.waitFor();
  expect(await card.textContent()).toContain("existe aussi dans le design system");
  expect(await card.textContent()).toContain("Lumora diffuse son propre ui-slot-picker depuis la diffusion 2. App garde le sien tant que tu ne changes pas.");
  expect(await tab.getByTestId("component-mission-card").textContent()).not.toContain("existe aussi");
  if (captures) await tab.screenshot({ path: join(captures, "17-app-card.png") });

  await card.getByRole("button", { name: "Passer à celui du design system" }).click();
  await card.waitFor({ state: "detached" });
  expect((await detail(project)).components.map((c) => c.name)).toEqual(["mission-card"]);
  await tab.close();
});
