import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { build } from "vite";
import { chromium, type Browser } from "playwright";
import { afterAll, beforeAll, expect, it } from "vitest";
import type { AgentTokenResponse, Page, Project } from "@redline/shared";
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

const PAGE_FILES = { "home.html": "<!doctype html><h1>Home</h1>", "manifest.json": JSON.stringify({ artboards: [{ file: "home.html" }] }) };

/** A page held by a terminal session, with one waiting thread per body. */
async function heldPage(sessionId: string, title: string, bodies: string[]) {
  const { token } = (await (await server.get("/api/agent-token")).json()) as AgentTokenResponse;
  const call = (path: string, body: unknown) =>
    fetch(`${server.url}/agent-api${path}`, { method: "POST", headers: { authorization: `Bearer ${token}`, "content-type": "application/json" }, body: JSON.stringify(body) });
  const project = (await (await server.post("/api/projects", { title })).json()) as Project;
  const page = (await (await server.post(`/api/projects/${project.id}/pages`, { title, files: PAGE_FILES })).json()) as Page;
  await call(`/terminal-sessions/${sessionId}/heartbeat`, { folder: "/Users/vince/claude-projects/lumora", machine: "MacBook-Pro" });
  await call(`/pages/${page.id}/versions`, { files: { ...PAGE_FILES, "home.html": "<h1>Terminal</h1>" }, message: "First", origin: "terminal", baseVersionId: page.version.id, terminalSessionId: sessionId });
  for (const body of bodies) await server.post(`/api/pages/${page.id}/threads`, { artboard: "home.html", selector: "h1", xPct: 10, yPct: 10, body });
  return page;
}

it("hands one waiting thread over to the agent from its footer, and leaves the page held", async () => {
  const page = await heldPage("terminal-h1", "Lumora", ["Reduce the button", "Shorter title"]);
  const tab = await browser.newPage({ viewport: { width: 1440, height: 900 } });
  await tab.goto(`${server.url}/#/pages/${page.id}`);
  await tab.getByRole("tab", { name: /^Commentaires/ }).click();
  const cards = tab.locator("article", { hasText: "En attente de la session terminal" });
  await expect.poll(() => cards.count()).toBe(2);

  const footer = cards.first().getByRole("button", { name: "Confier à l'agent" });
  const buttons = await cards.first().locator("button").allInnerTexts();
  expect(buttons.slice(-3)).toEqual(["Confier à l'agent", "Répondre", "Résoudre"]);

  const request = tab.waitForRequest((req) => req.method() === "POST" && /\/api\/threads\/[^/]+\/hand-over$/.test(req.url()));
  await footer.click();
  await request;

  await expect.poll(() => cards.count()).toBe(1);
  await expect.poll(() => tab.locator("article", { hasText: "En file · agent hors ligne" }).count()).toBe(1);
  expect(await tab.getByTestId("terminal-pill").count()).toBe(1);
  await tab.close();
}, 60_000);

it("hands the whole page over from the pill's popover: the pill and the waiting mentions go away", async () => {
  const page = await heldPage("terminal-h2", "Blog", ["One", "Two"]);
  const tab = await browser.newPage({ viewport: { width: 1440, height: 900 } });
  await tab.goto(`${server.url}/#/pages/${page.id}`);
  await tab.getByRole("tab", { name: /^Commentaires/ }).click();
  const waiting = tab.locator("article", { hasText: "En attente de la session terminal" });
  await expect.poll(() => waiting.count()).toBe(2);

  await tab.getByTestId("terminal-pill").click();
  const request = tab.waitForRequest((req) => req.method() === "POST" && req.url().endsWith(`/api/pages/${page.id}/terminal-release`));
  await tab.getByRole("dialog", { name: "Session terminal" }).getByRole("button", { name: "Confier la page à l'agent" }).click();
  await request;

  await expect.poll(() => tab.getByTestId("terminal-pill").count()).toBe(0);
  await expect.poll(() => waiting.count()).toBe(0);
  expect(await tab.getByRole("button", { name: "Confier à l'agent" }).count()).toBe(0);
  await tab.close();
}, 60_000);
