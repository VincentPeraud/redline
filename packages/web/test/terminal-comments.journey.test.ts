import { createHash } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { copyBuiltWeb } from "./builtWeb.js";
import { type Browser } from "playwright";
import { launchBrowser } from "./journeyBrowser.js";
import { afterAll, beforeAll, expect, it } from "vitest";
import type { AgentTokenResponse, Page, Project, Thread } from "@redline/shared";
import { startTestServer, type TestServer } from "@redline/server/test-harness";

let server: TestServer;
let browser: Browser;
let webDir: string;

beforeAll(async () => {
  webDir = mkdtempSync(join(tmpdir(), "redline-web-"));
  copyBuiltWeb(webDir);
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

/** The calls `redline mcp` makes: presence, a publish that takes the page, pending_comments and reply_in_thread. */
async function terminalSession(name: string) {
  const sessionId = sessionIdOf(name);
  const { token } = (await (await server.get("/api/agent-token")).json()) as AgentTokenResponse;
  const call = (path: string, body: unknown) =>
    fetch(`${server.url}/agent-api${path}`, { method: "POST", headers: { authorization: `Bearer ${token}`, "content-type": "application/json" }, body: JSON.stringify(body) });
  return {
    async open(page: Page) {
      await call(`/terminal-sessions/${sessionId}/heartbeat`, { folder: "/work/lumora", machine: "MacBook-Pro" });
      const current = (await (await server.get(`/api/pages/${page.id}`)).json()) as Page;
      await call(`/pages/${page.id}/versions`, { files: { ...PAGE_FILES, "home.html": "<h1>Built</h1>" }, message: "Built", origin: "terminal", baseVersionId: current.version.id, terminalSessionId: sessionId });
    },
    pick: () => call(`/terminal-sessions/${sessionId}/pick`, {}),
    reply: (threadId: string, body: string) => call(`/threads/${threadId}/replies`, { body, terminalSessionId: sessionId }),
  };
}

it("shows the running look on a thread the terminal session picked, then 'session terminal' once it answered", async () => {
  const project = (await (await server.post("/api/projects", { title: "Lumora" })).json()) as Project;
  const page = (await (await server.post(`/api/projects/${project.id}/pages`, { title: "Accueil", files: PAGE_FILES })).json()) as Page;
  const session = await terminalSession("terminal-handles");
  await session.open(page);
  const thread = (await (await server.post(`/api/pages/${page.id}/threads`, { artboard: "home.html", selector: "h1", xPct: 20, yPct: 30, body: "Make it blue" })).json()) as Thread;

  const tab = await browser.newPage({ viewport: { width: 1440, height: 900 } });
  await tab.goto(`${server.url}/#/pages/${page.id}`);
  await tab.getByRole("tab", { name: /^Commentaires/ }).click();
  await expect.poll(() => tab.getByTestId("queued").textContent()).toBe("En attente de la session terminal");

  await session.pick();
  await expect.poll(() => tab.getByTestId("queued").count()).toBe(0);
  await expect.poll(() => tab.getByText("Claude travaille sur ce fil…").count()).toBe(1);
  expect(await tab.getByText(/^session terminal/).count()).toBe(1);

  await session.reply(thread.id, "Done, in blue");
  await expect.poll(() => tab.getByText("Claude travaille sur ce fil…").count()).toBe(0);
  await expect.poll(() => tab.getByTestId("reply").innerText()).toContain("Done, in blue");
  expect(await tab.getByText(/^session terminal/).count()).toBe(1);
  await tab.close();
}, 60_000);
