import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { build } from "vite";
import { chromium, type Browser } from "playwright";
import { afterAll, beforeAll, expect, it } from "vitest";
import { starterPageFiles, type Page, type Project } from "@redline/shared";
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

it("shows recent pages, running work and agents on the home, with live sidebar counts", async () => {
  const project = (await (await server.post("/api/projects", { title: "Acme" })).json()) as Project;
  const files = starterPageFiles(null);
  const page = (await (await server.post(`/api/projects/${project.id}/pages`, { title: "Landing", files })).json()) as Page;

  const tab = await browser.newPage();
  await tab.goto(`${server.url}/#/nowhere/1`);
  await tab.getByRole("heading", { name: "Accueil" }).waitFor();
  await tab.getByTestId("home-projects").getByText("Acme").waitFor();
  await expect.poll(() => tab.getByTestId("sidebar-online").textContent()).toBe("Aucun agent connecté");

  const agent = await server.connectAgent({ machine: "MacBook", folder: "/work/acme", projectId: project.id });
  await agent.hello;
  await expect.poll(() => tab.getByTestId("sidebar-online").textContent()).toBe("1 agent connecté");
  await expect.poll(() => tab.getByTestId("sidebar-details").textContent()).toBe("0 hors ligne · 0 fil en attente");
  await tab.getByTestId("home-agents").getByText("Libre").waitFor();

  await server.post(`/api/pages/${page.id}/threads`, { artboard: "index.html", selector: "h1", xPct: 1, yPct: 1, body: "Bigger" });
  await server.post(`/api/pages/${page.id}/threads`, { artboard: "index.html", selector: "p", xPct: 2, yPct: 2, body: "Smaller" });
  await tab.getByTestId("home-sessions").getByText("En cours").waitFor();
  await tab.getByTestId("home-agents").getByText("Occupé").waitFor();
  await expect.poll(() => tab.getByTestId("sidebar-details").textContent()).toBe("0 hors ligne · 1 fil en attente");

  agent.close();
  await agent.closed;
  await expect.poll(() => tab.getByTestId("sidebar-online").textContent()).toBe("Aucun agent connecté");
  await expect.poll(() => tab.getByTestId("sidebar-details").textContent()).toContain("1 hors ligne");
}, 60_000);

it("lists every agent on the Agents screen and lets the takeover choice be changed there", async () => {
  const project = (await (await server.post("/api/projects", { title: "Blog" })).json()) as Project;
  await server.post("/api/projects", { title: "Solo" });
  const projectAgent = await server.connectAgent({ machine: "iMac", folder: "/work/blog", projectId: project.id, model: "sonnet", effort: "low" });
  await projectAgent.hello;
  const global = await server.connectAgent({ machine: "MacBook", folder: "/global", kind: "global" });
  await global.hello;

  const tab = await browser.newPage();
  await tab.goto(`${server.url}/#/agents`);
  const card = tab.getByTestId("agent-card").filter({ hasText: "/work/blog" });
  await card.waitFor();
  await expect.poll(() => card.getByTestId("agent-defaults").textContent()).toBe("Sonnet · low");
  expect(await card.getByTestId("agent-projects").textContent()).toBe("Blog");
  expect(await card.getByTestId("agent-status").textContent()).toBe("Libre");
  await tab.getByText("redline agent --global").waitFor();

  expect(await tab.getByRole("radiogroup").count()).toBe(1);
  const takeover = tab.getByRole("radiogroup", { name: "Quand l'agent d'un projet est hors ligne" }).getByLabel("L'agent global prend le relais");
  await expect.poll(() => tab.getByLabel("Le fil attend son retour").isChecked()).toBe(true);
  await takeover.click();
  await expect.poll(async () => ((await (await server.get("/api/settings")).json()) as { globalTakeover: boolean }).globalTakeover).toBe(true);
  await expect
    .poll(async () => ((await (await server.get(`/api/projects/${project.id}`)).json()) as Project).globalTakeover)
    .toBe(true);
  await expect.poll(() => takeover.isChecked()).toBe(true);

  const globalCard = tab.getByTestId("agent-card").filter({ hasText: "/global" });
  expect(await globalCard.getByTestId("agent-projects").textContent()).toBe("Solo");
}, 60_000);
