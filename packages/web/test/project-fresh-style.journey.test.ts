import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { copyBuiltWeb } from "./builtWeb.js";
import { type Browser } from "playwright";
import { launchBrowser } from "./journeyBrowser.js";
import { afterAll, beforeAll, expect, it } from "vitest";
import type { Project } from "@redline/shared";
import { startTestServer, type TestServer } from "@redline/server/test-harness";

const shots = "/private/tmp/claude-501/-Users-vincentperaud-claude-projects-redline/0f6c9635-9fe2-47bf-9743-78a0a485b075/scratchpad";

let server: TestServer;
let browser: Browser;
let webDir: string;

beforeAll(async () => {
  webDir = mkdtempSync(join(tmpdir(), "redline-web-"));
  copyBuiltWeb(webDir);
  server = await startTestServer({ webDir });
  browser = await launchBrowser();
  mkdirSync(shots, { recursive: true });
}, 60_000);

afterAll(async () => {
  await browser?.close();
  await server?.stop();
  rmSync(webDir, { recursive: true, force: true });
});

const explanation = "Claude le crée d'après le sujet du projet à ta première demande : polices, fond, couleurs d'accent. Tu pourras ensuite le modifier ici ou en le lui demandant.";

it("shows 'Pas encore de style' on the design system page of a new project without a design system", async () => {
  const project = (await (await server.post("/api/projects", { title: "Fresh" })).json()) as Project;
  const tab = await browser.newPage({ viewport: { width: 1440, height: 900 } });
  await tab.goto(`${server.url}/#/projects/${project.id}/design-system`);

  await tab.getByText("Pas encore de style").waitFor();
  await tab.getByText(explanation).waitFor();
  await tab.getByText("Aucune pour l'instant").waitFor();
  expect(await tab.getByTestId(/^token-/).count()).toBe(0);
  await tab.screenshot({ path: join(shots, "nns-04-fresh.png") });
  await tab.close();
});

it("disables 'En faire un design system…' while the project style defines no token, and explains why on hover", async () => {
  const project = (await (await server.post("/api/projects", { title: "Fresh promote" })).json()) as Project;
  const tab = await browser.newPage({ viewport: { width: 1440, height: 900 } });
  await tab.goto(`${server.url}/#/projects/${project.id}/design-system`);

  const promote = tab.getByRole("button", { name: "En faire un design system…" });
  await promote.waitFor();
  expect(await promote.isDisabled()).toBe(true);
  await tab.screenshot({ path: join(shots, "nns-fix-fresh.png") });
  await promote.hover();
  await tab.getByRole("tooltip", { name: "Le style du projet est encore vide" }).waitFor();
  await tab.waitForTimeout(300);
  await tab.screenshot({ path: join(shots, "nns-fix-fresh-tooltip.png") });
  await tab.close();
});

it("shows the variables table with the style hint once the project style holds tokens", async () => {
  const project = (await (await server.post("/api/projects", { title: "Styled" })).json()) as Project;
  await fetch(`${server.url}/api/projects/${project.id}/project-style`, {
    method: "PUT",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ content: ":root {\n  --color-primary: #f25c2a;\n  --font-heading: Poppins;\n}\n" }),
  });
  const tab = await browser.newPage({ viewport: { width: 1440, height: 900 } });
  await tab.goto(`${server.url}/#/projects/${project.id}/design-system`);

  await tab.getByTestId("token---color-primary").waitFor();
  await tab.getByText("Le style du projet : modifiables ici ou en le demandant à Claude").waitFor();
  expect(await tab.getByRole("button", { name: "En faire un design system…" }).isEnabled()).toBe(true);
  expect(await tab.getByText("Pas encore de style").count()).toBe(0);
  await tab.screenshot({ path: join(shots, "nns-04-with-style.png") });
  await tab.close();
});

it("describes the 'Aucun pour l'instant' option as a style Claude creates, in the new project dialog", async () => {
  const tab = await browser.newPage({ viewport: { width: 1440, height: 900 } });
  await tab.goto(`${server.url}/#/projects`);
  await tab.getByRole("button", { name: "Nouveau projet", exact: true }).click();
  await tab.getByRole("radio", { name: /Aucun pour l'instant.*Claude crée un style d'après le sujet du projet/ }).waitFor();
  await tab.screenshot({ path: join(shots, "nns-04-new-project.png") });
  await tab.close();
});
