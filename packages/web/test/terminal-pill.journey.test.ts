import { createHash } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { copyBuiltWeb } from "./builtWeb.js";
import { type Browser } from "playwright";
import { launchBrowser } from "./journeyBrowser.js";
import { afterAll, beforeAll, expect, it } from "vitest";
import type { AgentTokenResponse, Page, Project } from "@redline/shared";
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

/** The calls `redline mcp` makes: presence, then a terminal publish that takes the page. */
async function terminalSession(name: string, folder: string, machine: string) {
  const sessionId = sessionIdOf(name);
  const { token } = (await (await server.get("/api/agent-token")).json()) as AgentTokenResponse;
  const call = (path: string, body: unknown) =>
    fetch(`${server.url}/agent-api${path}`, { method: "POST", headers: { authorization: `Bearer ${token}`, "content-type": "application/json" }, body: JSON.stringify(body) });
  return {
    heartbeat: () => call(`/terminal-sessions/${sessionId}/heartbeat`, { folder, machine }),
    bye: () => call(`/terminal-sessions/${sessionId}/bye`, {}),
    async publish(page: Page, message: string) {
      const current = (await (await server.get(`/api/pages/${page.id}`)).json()) as Page;
      await call(`/pages/${page.id}/versions`, { files: { ...PAGE_FILES, "home.html": `<h1>${message}</h1>` }, message, origin: "terminal", baseVersionId: current.version.id, terminalSessionId: sessionId });
    },
  };
}

it("shows the terminal pill and its popover while a present terminal session holds the page, live, and hides them when it leaves", async () => {
  const project = (await (await server.post("/api/projects", { title: "Lumora" })).json()) as Project;
  const page = (await (await server.post(`/api/projects/${project.id}/pages`, { title: "Accueil", files: PAGE_FILES })).json()) as Page;
  const tab = await browser.newPage({ viewport: { width: 1440, height: 900 } });
  await tab.goto(`${server.url}/#/pages/${page.id}`);
  await tab.getByRole("navigation", { name: "Fil d'Ariane" }).waitFor();
  const pill = tab.getByTestId("terminal-pill");
  expect(await pill.count()).toBe(0);

  const session = await terminalSession("terminal-a", "/Users/vince/claude-projects/lumora", "MacBook-Pro");
  await session.heartbeat();
  await session.publish(page, "First");
  await expect.poll(() => pill.textContent()).toBe(">_Session terminal · les commentaires lui iront");

  await pill.click();
  const popover = tab.getByRole("dialog", { name: "Session terminal" });
  expect(await popover.innerText()).toContain("~/claude-projects/lumora");
  expect(await popover.innerText()).toContain("MacBook-Pro · connectée · a publié la page à l'instant");
  expect(await popover.innerText()).toContain("Dis-lui « traite mes commentaires » dans le terminal.");
  expect(await popover.getByRole("button", { name: "Confier la page à l'agent" }).count()).toBe(1);

  await tab.keyboard.press("Escape");
  await expect.poll(() => popover.count()).toBe(0);
  await pill.click();
  await tab.mouse.click(600, 28);
  await expect.poll(() => popover.count()).toBe(0);

  await session.bye();
  await expect.poll(() => pill.count()).toBe(0);
  await tab.close();
}, 60_000);

it("moves the pill to the next terminal session that publishes the page", async () => {
  const project = (await (await server.post("/api/projects", { title: "Blog" })).json()) as Project;
  const page = (await (await server.post(`/api/projects/${project.id}/pages`, { title: "Home", files: PAGE_FILES })).json()) as Page;
  const tab = await browser.newPage({ viewport: { width: 1440, height: 900 } });
  await tab.goto(`${server.url}/#/pages/${page.id}`);
  const first = await terminalSession("terminal-b", "/work/blog", "MacBook-Pro");
  const second = await terminalSession("terminal-c", "/work/blog-2", "iMac");
  await first.heartbeat();
  await second.heartbeat();
  await first.publish(page, "First");
  const pill = tab.getByTestId("terminal-pill");
  await pill.waitFor();
  await pill.click();
  await expect.poll(() => tab.getByRole("dialog", { name: "Session terminal" }).innerText()).toContain("MacBook-Pro");

  await second.publish(page, "Second");
  await expect.poll(() => tab.getByRole("dialog", { name: "Session terminal" }).innerText()).toContain("iMac");
  await tab.close();
}, 60_000);
