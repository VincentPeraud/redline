import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { build } from "vite";
import { chromium, type Browser } from "playwright";
import { afterAll, beforeAll, expect, it } from "vitest";
import type { DesignMdResponse, Project } from "@redline/shared";
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

it("edits and saves DESIGN.md and adds an asset from the DESIGN.md screen", async () => {
  const project = (await (await server.post("/api/projects", { title: "Acme" })).json()) as Project;
  const tab = await browser.newPage();
  await tab.goto(`${server.url}/#/projects/${project.id}`);
  await tab.getByRole("link", { name: "DESIGN.md" }).click();

  const editor = tab.getByLabel("Contenu de DESIGN.md");
  const save = tab.getByRole("button", { name: "Enregistrer" });
  await editor.waitFor();
  expect(await save.isDisabled()).toBe(true);

  await editor.fill("# Acme\n- One action per screen");
  expect(await tab.getByTestId("design-md-status").textContent()).toBe("Modifications non enregistrées");
  await save.click();
  await expect
    .poll(async () => ((await (await server.get(`/api/projects/${project.id}/design-md`)).json()) as DesignMdResponse).content)
    .toBe("# Acme\n- One action per screen");
  await expect.poll(async () => tab.getByTestId("design-md-status").textContent()).toBe("Enregistré");

  expect(await tab.getByTestId("rules").textContent()).toContain("Toi · création du projet");
  await tab.reload();
  await expect.poll(() => tab.getByTestId("design-md-status").textContent()).toBe("Dernière modification par toi · aujourd'hui");

  await tab.getByRole("button", { name: "1 version" }).click();
  await tab.getByRole("dialog", { name: "Historique de DESIGN.md" }).waitFor();
  await tab.keyboard.press("Escape");
  expect(await tab.getByTestId("rules").textContent()).toContain("One action per screen");

  await editor.fill("# Acme\n- Two actions per screen");
  await save.click();
  await tab.getByRole("button", { name: "2 versions" }).click();
  await tab.getByRole("button", { name: "Restaurer" }).click();
  expect(await editor.inputValue()).toBe("# Acme\n- One action per screen");
  expect(await tab.getByTestId("design-md-status").textContent()).toBe("Modifications non enregistrées");

  await tab.close();
});
