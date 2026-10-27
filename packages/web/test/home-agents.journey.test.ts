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
  const takeover = tab.getByRole("radiogroup", { name: "Quand aucun agent ne tourne pour le projet" }).getByLabel("L'agent global le prend");
  await expect.poll(() => tab.getByRole("radio", { name: /Le fil attend/ }).isChecked()).toBe(true);
  await takeover.click();
  await expect.poll(async () => ((await (await server.get("/api/settings")).json()) as { globalTakeover: boolean }).globalTakeover).toBe(true);
  await expect
    .poll(async () => ((await (await server.get(`/api/projects/${project.id}`)).json()) as Project).globalTakeover)
    .toBe(true);
  await expect.poll(() => takeover.isChecked()).toBe(true);

  const globalCard = tab.getByTestId("agent-card").filter({ hasText: "/global" });
  await expect.poll(() => globalCard.getByTestId("agent-projects").textContent()).toContain("Solo");  expect(await globalCard.getByTestId("agent-projects").textContent()).toContain("Blog");
  expect(await card.getByRole("button", { name: "Projets couverts" }).count()).toBe(0);

  await globalCard.getByRole("button", { name: "Projets couverts" }).click();
  const covered = globalCard.getByRole("list", { name: "Projets couverts" });
  await expect.poll(() => covered.getByRole("listitem").filter({ hasText: "Solo" }).textContent()).toContain("Sert maintenant");
  expect(await covered.getByRole("listitem").filter({ hasText: "Blog" }).textContent()).not.toContain("Sert maintenant");
}, 60_000);

it("shows a stopped project agent as offline with its waiting thread, without a covered projects button", async () => {
  const project = (await (await server.post("/api/projects", { title: "Reels" })).json()) as Project;
  await fetch(`${server.url}/api/projects/${project.id}`, { method: "PATCH", headers: { "content-type": "application/json" }, body: JSON.stringify({ globalTakeoverOverride: false }) });
  const files = starterPageFiles(null);
  const page = (await (await server.post(`/api/projects/${project.id}/pages`, { title: "Landing", files })).json()) as Page;
  const agent = await server.connectAgent({ machine: "Waiting-iMac", folder: "/work/reels", projectId: project.id });
  await agent.hello;
  agent.close();
  await agent.closed;
  await server.post(`/api/pages/${page.id}/threads`, { artboard: "index.html", selector: "h1", xPct: 1, yPct: 1, body: "Bigger" });

  const tab = await browser.newPage();
  await tab.goto(`${server.url}/#/agents`);
  const card = tab.getByTestId("agent-card").filter({ hasText: "/work/reels" });
  await card.getByText("1 fil attend un agent").waitFor();
  expect(await card.getByTestId("agent-status").textContent()).toBe("Hors ligne");
  expect(await card.getByText(/vu /).count()).toBe(1);
  expect(await card.getByRole("button", { name: "Projets couverts" }).count()).toBe(0);
}, 60_000);
