import { createHash } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { build } from "vite";
import { type Browser } from "playwright";
import { launchBrowser } from "./journeyBrowser.js";
import { afterAll, beforeAll, expect, it } from "vitest";
import type { AgentTokenResponse, Page, Project, SessionRow, Thread } from "@redline/shared";
import { startTestServer, type TestServer } from "@redline/server/test-harness";

const webRoot = fileURLToPath(new URL("..", import.meta.url));

let server: TestServer;
let browser: Browser;
let webDir: string;

beforeAll(async () => {
  webDir = mkdtempSync(join(tmpdir(), "redline-web-"));
  await build({ root: webRoot, logLevel: "silent", build: { outDir: webDir, emptyOutDir: true } });
  server = await startTestServer({ webDir });
  browser = await launchBrowser();
}, 60_000);

afterAll(async () => {
  await browser?.close();
  await server?.stop();
  rmSync(webDir, { recursive: true, force: true });
});

/** A terminal session id is a UUID: the tests name their sessions, this makes the id of a name. */
const sessionIdOf = (name: string) => createHash("md5").update(name).digest("hex").replace(/^(.{8})(.{4})(.{4})(.{4})(.{12})$/, "$1-$2-$3-$4-$5");

const PAGE_FILES = { "home.html": "<!doctype html><h1>Home</h1>", "manifest.json": JSON.stringify({ artboards: [{ file: "home.html" }] }) };

async function terminalSession(name: string) {
  const sessionId = sessionIdOf(name);
  const { token } = (await (await server.get("/api/agent-token")).json()) as AgentTokenResponse;
  const call = (path: string, body: unknown) =>
    fetch(`${server.url}/agent-api${path}`, { method: "POST", headers: { authorization: `Bearer ${token}`, "content-type": "application/json" }, body: JSON.stringify(body) });
  return {
    bye: () => call(`/terminal-sessions/${sessionId}/bye`, {}),
    async open(page: Page) {
      await call(`/terminal-sessions/${sessionId}/heartbeat`, { folder: "/work/lumora", machine: "MacBook-Pro" });
      const current = (await (await server.get(`/api/pages/${page.id}`)).json()) as Page;
      await call(`/pages/${page.id}/versions`, { files: { ...PAGE_FILES, "home.html": "<h1>Built</h1>" }, message: "Built", origin: "terminal", baseVersionId: current.version.id, terminalSessionId: sessionId });
    },
  };
}

it("shows 'En attente de la session terminal' on a waiting thread and on Sessions, and drops it live when the terminal session leaves", async () => {
  const project = (await (await server.post("/api/projects", { title: "Lumora" })).json()) as Project;
  const page = (await (await server.post(`/api/projects/${project.id}/pages`, { title: "Accueil", files: PAGE_FILES })).json()) as Page;
  const session = await terminalSession("terminal-waiting");
  await session.open(page);
  const thread = (await (await server.post(`/api/pages/${page.id}/threads`, { artboard: "home.html", selector: "h1", xPct: 20, yPct: 30, body: "Make it blue" })).json()) as Thread;

  const tab = await browser.newPage({ viewport: { width: 1440, height: 900 } });
  await tab.goto(`${server.url}/#/pages/${page.id}`);
  await tab.getByRole("tab", { name: /^Commentaires/ }).click();
  const mention = tab.getByTestId("queued");
  await expect.poll(() => mention.textContent()).toBe("En attente de la session terminal");

  const rows = (await (await server.get("/api/sessions")).json()) as SessionRow[];
  expect(rows.find((r) => r.id === thread.id)).toMatchObject({ waitingReason: "terminal" });
  await tab.goto(`${server.url}/#/sessions`);
  await tab.getByText("Make it blue").first().click();
  await expect.poll(() => tab.getByText(/en attente de la session terminal/).count()).toBeGreaterThan(0);

  await tab.goto(`${server.url}/#/pages/${page.id}`);
  await tab.getByRole("tab", { name: /^Commentaires/ }).click();
  await expect.poll(() => mention.textContent()).toBe("En attente de la session terminal");
  await session.bye();
  await expect.poll(() => mention.textContent()).toBe("En file · agent hors ligne");
  await tab.close();
}, 60_000);
