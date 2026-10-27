import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { build } from "vite";
import { chromium, type Browser } from "playwright";
import { afterAll, beforeAll, expect, it } from "vitest";
import { PROTOCOL_VERSION, type Project } from "@redline/shared";
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

it("updates an outdated agent from its row: progress while it installs, then the error when it fails", async () => {
  const current = await server.connectAgent({ machine: "MacBook", folder: "/work/blog", buildHash: "server-build" });
  await current.hello;
  const global = await server.connectAgent({ machine: "MacBook", folder: "/global", kind: "global", buildHash: "old-build" });
  await global.hello;

  const tab = await browser.newPage();
  await tab.goto(`${server.url}/#/agents`);
  await tab.getByRole("heading", { name: "Agents", exact: true }).waitFor();
  const cards = tab.getByTestId("agent-card");
  expect(await cards.filter({ hasText: "/work/blog" }).getByRole("button", { name: "Mettre à jour" }).count()).toBe(0);

  const globalCard = cards.filter({ hasText: "/global" });
  await globalCard.getByRole("button", { name: "Mettre à jour" }).click();
  await expect.poll(() => global.messages.some((m) => m.type === "update")).toBe(true);
  await globalCard.getByRole("button", { name: "Mise à jour…" }).waitFor();
  expect(await globalCard.getByRole("button", { name: "Mise à jour…" }).isDisabled()).toBe(true);

  global.send({ type: "update-failed", message: "npm ERR! network" });
  await globalCard.getByTestId("agent-update-error").getByText("La mise à jour a échoué : npm ERR! network").waitFor();
  await globalCard.getByRole("button", { name: "Mettre à jour" }).waitFor();

  global.close();
  current.close();
  await tab.close();
});

it("shows the project of a refused project agent, and none for a global one", async () => {
  const project = (await (await server.post("/api/projects", { title: "Blog Lumora" })).json()) as Project;
  const refusedProject = await server.connectAgent({ machine: "iMac", folder: "/projets/blog", projectId: project.id, protocolVersion: PROTOCOL_VERSION + 1 });
  await refusedProject.hello;
  const refusedGlobal = await server.connectAgent({ machine: "iMac", folder: "/projets/global", kind: "global", protocolVersion: PROTOCOL_VERSION + 1 });
  await refusedGlobal.hello;

  const tab = await browser.newPage();
  await tab.goto(`${server.url}/#/agents`);
  const cards = tab.getByTestId("refused-agent-card");
  const blog = cards.filter({ hasText: "/projets/blog" });
  await blog.getByText("Blog Lumora").waitFor();
  await blog.getByText("Ne peut plus se connecter").waitFor();
  expect(await cards.filter({ hasText: "/projets/global" }).getByText("Blog Lumora").count()).toBe(0);
  await tab.close();
});
