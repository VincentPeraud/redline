import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { build } from "vite";
import { chromium, type Browser } from "playwright";
import { afterAll, beforeAll, expect, it } from "vitest";
import type { Conversation, DesignSystem, DesignSystemSummary, Project } from "@redline/shared";
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

it("lists design systems with their projects, creates one and shows the hint in the new-project picker", async () => {
  const ds = (await (await server.post("/api/design-systems", { title: "DS Lumora" })).json()) as DesignSystem;
  await server.post("/api/projects", { title: "Lumora", designSystem: ds.id });
  const source = (await (await server.post("/api/projects", { title: "Blog" })).json()) as Project;

  const tab = await browser.newPage();
  await tab.goto(`${server.url}/#/design-systems`);
  await expect.poll(async () => tab.getByTestId("design-systems").textContent()).toContain("DS Lumora");
  expect(await tab.getByTestId("design-systems").textContent()).toContain("Utilisé par Lumora");

  await tab.getByRole("button", { name: "Ajouter un design system" }).click();
  await tab.getByLabel("Nom").fill("DS Blog");
  await tab.getByLabel("Partir des pages d'un projet (facultatif)").selectOption(source.id);
  await tab.getByLabel("Instructions").fill("Keep it calm");
  await tab.getByRole("button", { name: "Créer le design system" }).click();

  await expect
    .poll(async () => ((await (await server.get("/api/design-systems")).json()) as DesignSystemSummary[]).map((d) => d.title))
    .toContain("DS Blog");
  const created = ((await (await server.get("/api/design-systems")).json()) as DesignSystemSummary[]).find((d) => d.title === "DS Blog")!;
  await expect.poll(() => tab.url()).toContain(`#/pages/${created.pageId}`);
  const conversations = (await (await server.get(`/api/pages/${created.pageId}/conversations`)).json()) as Conversation[];
  expect(conversations).toHaveLength(1);

  await tab.goto(`${server.url}/#/`);
  await tab.getByRole("button", { name: "New project" }).click();
  await expect.poll(async () => tab.getByRole("option", { name: /DS Lumora — Utilisé par Lumora/ }).count()).toBe(1);
  await tab.close();
});
