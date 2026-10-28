import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { build } from "vite";
import { chromium, type Browser } from "playwright";
import { afterAll, beforeAll, expect, it } from "vitest";
import type { DesignSystem, Project } from "@redline/shared";
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

it("archives a project from its page, finds it under Projets archivés, unarchives it, then deletes it once its name is typed", async () => {
  const project = (await (await server.post("/api/projects", { title: "Lumora v1" })).json()) as Project;
  await server.post(`/api/projects/${project.id}/pages`, { title: "Accueil", files: { "index.html": "<h1>Hi</h1>" } });
  const tab = await browser.newPage();
  await tab.goto(`${server.url}/#/projects/${project.id}`);

  await tab.getByRole("button", { name: "Archiver ce projet" }).click();
  const confirm = tab.getByRole("dialog", { name: "Archiver « Lumora v1 » ?" });
  await confirm.getByRole("button", { name: "Archiver", exact: true }).click();

  const banner = tab.getByRole("status").filter({ hasText: "Projet archivé le" });
  await banner.waitFor();
  expect(await tab.getByRole("button", { name: "Nouvelle page" }).count()).toBe(0);

  await tab.goto(`${server.url}/#/projects`);
  await tab.getByRole("link", { name: "Projets archivés · 1" }).click();
  await tab.getByRole("heading", { name: "Projets archivés" }).waitFor();
  await tab.getByRole("link").filter({ hasText: "Lumora v1" }).getByText("Archivé", { exact: true }).waitFor();
  await tab.getByRole("link").filter({ hasText: "Lumora v1" }).click();

  await tab.getByRole("status").getByRole("button", { name: "Désarchiver" }).click();
  await tab.getByRole("button", { name: "Archiver ce projet" }).waitFor();
  expect(((await (await server.get(`/api/projects/${project.id}`)).json()) as Project).archivedAt).toBeUndefined();

  await tab.getByRole("button", { name: "Archiver ce projet" }).click();
  await tab.getByRole("dialog").getByRole("button", { name: "Archiver", exact: true }).click();
  await tab.getByRole("button", { name: "Supprimer définitivement…" }).click();
  const remove = tab.getByRole("dialog", { name: "Supprimer « Lumora v1 » définitivement ?" });
  await remove.getByText("Ses 1 page, 0 fil, 1 version").waitFor();
  const red = remove.getByRole("button", { name: "Supprimer définitivement", exact: true });
  await red.click({ force: true });
  expect(await red.getAttribute("aria-disabled")).toBe("true");
  expect((await server.get(`/api/projects/${project.id}`)).status).toBe(200);
  await remove.getByLabel("Tape le nom du projet pour confirmer").fill("Lumora v1");
  await red.click();

  await expect.poll(() => tab.url()).toContain("#/archived-projects");
  expect((await server.get(`/api/projects/${project.id}`)).status).toBe(404);
}, 60_000);

it("keeps a design system followed by an archived project from being archived, and says why", async () => {
  const ds = (await (await server.post("/api/design-systems", { title: "DS Lumora Marketing" })).json()) as DesignSystem;
  const follower = (await (await server.post("/api/projects", { title: "Lumora v2", designSystem: ds.id })).json()) as Project;
  await server.post(`/api/projects/${follower.id}/archive`, {});
  const tab = await browser.newPage();
  await tab.goto(`${server.url}/#/design-systems/${ds.id}`);

  await tab.getByText("Suivi par 1 projet, dont 1 archivé : change d'abord leur design system.").waitFor();
  expect(await tab.getByRole("button", { name: "Archiver ce design system" }).getAttribute("aria-disabled")).toBe("true");
  await tab.getByTestId("ds-user").filter({ hasText: "Lumora v2" }).getByText("Archivé", { exact: true }).waitFor();

  await server.post(`/api/projects/${follower.id}/unarchive`, {});
  await server.post(`/api/projects/${follower.id}/archive`, {}); // still followed: archived or not
  await fetch(`${server.url}/api/projects/${follower.id}`, { method: "DELETE", headers: { "content-type": "application/json" }, body: JSON.stringify({ title: "Lumora v2" }) });
  await tab.reload();
  await tab.getByRole("button", { name: "Archiver ce design system" }).click();
  await tab.getByRole("dialog", { name: "Archiver « DS Lumora Marketing » ?" }).getByRole("button", { name: "Archiver", exact: true }).click();
  await tab.getByRole("status").filter({ hasText: "Design system archivé le" }).waitFor();

  await tab.goto(`${server.url}/#/design-systems`);
  await tab.getByRole("link", { name: "Design systems archivés · 1" }).click();
  await tab.getByRole("heading", { name: "Design systems archivés" }).waitFor();
  await tab.getByRole("link").filter({ hasText: "DS Lumora Marketing" }).waitFor();
}, 60_000);
