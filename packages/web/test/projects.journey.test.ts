import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { build } from "vite";
import { chromium, type Browser } from "playwright";
import { afterAll, beforeAll, expect, it } from "vitest";
import type { Project } from "@redline/shared";
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

it("creates a project, then a page from its overview, and opens it on the canvas", async () => {
  const tab = await browser.newPage();
  await tab.goto(`${server.url}/#/projects`);

  await tab.getByRole("button", { name: "New project" }).click();
  const dialog = tab.getByRole("dialog", { name: "New project" });
  await dialog.getByLabel("Title").fill("Acme");
  await dialog.getByLabel("Instructions").fill("Calm and editorial");
  await dialog.getByRole("button", { name: "Create project" }).click();

  await expect.poll(async () => ((await (await server.get("/api/projects")).json()) as Project[]).length).toBe(1);
  const [project] = (await (await server.get("/api/projects")).json()) as Project[];
  expect(project).toMatchObject({ title: "Acme", instructions: "Calm and editorial", designSystem: null });

  await tab.getByRole("heading", { name: "Acme" }).waitFor();
  await tab.getByRole("link", { name: "Projects" }).click();
  await tab.getByRole("link", { name: "Acme" }).click();
  await tab.getByRole("heading", { name: "Acme" }).waitFor();

  await tab.getByRole("button", { name: "New page" }).click();
  const pageDialog = tab.getByRole("dialog", { name: "New page" });
  await pageDialog.getByLabel("Title").fill("Landing");
  await pageDialog.getByLabel("Comparison").check();
  await pageDialog.getByRole("button", { name: "Create page" }).click();

  await expect.poll(() => tab.url()).toContain("#/pages/");
  await expect.poll(() => tab.locator("iframe").count()).toBe(2);

  await tab.getByRole("link", { name: "Acme" }).click();
  const card = tab.getByRole("link", { name: /Landing/ });
  await card.waitFor();
  await expect.poll(() => card.locator("iframe").count()).toBe(1);
  await card.getByText("comparison").waitFor();
}, 60_000);
