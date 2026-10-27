import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { build } from "vite";
import { chromium, type Browser } from "playwright";
import { afterAll, beforeAll, expect, it } from "vitest";
import { PROTOCOL_VERSION, cliUpdateCommand, pageHash, starterPageFiles, type Page, type Project } from "@redline/shared";
import { startTestServer, type TestServer } from "@redline/server/test-harness";

const webRoot = fileURLToPath(new URL("..", import.meta.url));

let server: TestServer;
let browser: Browser;
let webDir: string;
let cliDir: string;

beforeAll(async () => {
  webDir = mkdtempSync(join(tmpdir(), "redline-web-"));
  cliDir = mkdtempSync(join(tmpdir(), "redline-cli-"));
  writeFileSync(join(cliDir, "redline-cli.tgz"), "tarball");
  writeFileSync(join(cliDir, "build-hash.txt"), "server-build");
  await build({ root: webRoot, logLevel: "silent", build: { outDir: webDir, emptyOutDir: true } });
  server = await startTestServer({ webDir, cliDir });
  browser = await chromium.launch();
}, 60_000);

afterAll(async () => {
  await browser?.close();
  await server?.stop();
  rmSync(webDir, { recursive: true, force: true });
  rmSync(cliDir, { recursive: true, force: true });
});

it("warns on every screen when agents are not up to date, and shows them on the Agents screen", async () => {
  const project = (await (await server.post("/api/projects", { title: "Blog" })).json()) as Project;
  const page = (await (await server.post(`/api/projects/${project.id}/pages`, { title: "Landing", files: starterPageFiles(null) })).json()) as Page;

  const context = await browser.newContext({ permissions: ["clipboard-read", "clipboard-write"] });
  const tab = await context.newPage();
  await tab.goto(`${server.url}/#/`);
  await tab.getByRole("heading", { name: "Accueil" }).waitFor();
  expect(await tab.getByRole("status").count()).toBe(0);

  const current = await server.connectAgent({ machine: "MacBook", folder: "/work/blog", projectId: project.id, buildHash: "server-build" });
  await current.hello;
  expect(await tab.getByRole("status").count()).toBe(0);

  const global = await server.connectAgent({ machine: "MacBook", folder: "/global", kind: "global", buildHash: "old-build" });
  await global.hello;
  await tab.getByRole("status").getByText("L'agent global n'est pas à jour.").waitFor();

  await tab.goto(`${server.url}/${pageHash(page.id)}`);
  await tab.getByRole("navigation", { name: "Fil d'Ariane" }).waitFor();
  await tab.getByRole("status").getByText("L'agent global n'est pas à jour.").waitFor();

  const refused = await server.connectAgent({ machine: "iMac", folder: "/projets/reels", protocolVersion: PROTOCOL_VERSION + 1 });
  await refused.hello;
  await tab.getByRole("status").getByText("2 agents ne sont pas à jour : global et reels.").waitFor();

  await tab.getByRole("link", { name: "Voir les agents" }).click();
  await tab.getByRole("heading", { name: "Agents", exact: true }).waitFor();

  const globalCard = tab.getByTestId("agent-card").filter({ hasText: "/global" });
  await expect.poll(() => globalCard.getByTestId("agent-outdated").textContent()).toBe("Pas à jour");
  expect(await tab.getByTestId("agent-card").filter({ hasText: "/work/blog" }).getByTestId("agent-outdated").count()).toBe(0);

  const refusedCard = tab.getByTestId("refused-agent-card");
  await refusedCard.getByText("Pas à jour · refusé").waitFor();
  await refusedCard.getByText("Ne peut plus se connecter").waitFor();
  await refusedCard.getByRole("button", { name: "Copier la commande" }).click();
  expect(await tab.evaluate(() => navigator.clipboard.readText())).toBe(cliUpdateCommand(server.url));

  refused.close();
  global.close();
  current.close();
  await context.close();
}, 60_000);
