import Database from "better-sqlite3";
import { randomUUID } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { copyBuiltWeb } from "./builtWeb.js";
import type { Browser, Page } from "playwright";
import { afterAll, beforeAll, expect, it } from "vitest";
import { MANIFEST_PATH, type AgentTokenResponse, type Project, type Thread } from "@redline/shared";
import { hashPassword } from "../../server/src/accounts.js";
import { startServer, type RunningServer } from "../../server/src/start.js";
import { launchBrowser } from "./journeyBrowser.js";

const PASSWORD = "correct horse";
const JSON_HEADERS = { "content-type": "application/json" };
const ARIANE = "ariane@example.com";

let webDir: string;
let dataDir: string;
let browser: Browser;
let server: RunningServer;
let setupLink = "";

async function cookieOf(email: string): Promise<string> {
  const res = await fetch(`${server.url}/api/session`, { method: "POST", headers: JSON_HEADERS, body: JSON.stringify({ email, password: PASSWORD }) });
  return (res.headers.get("set-cookie") ?? "").split(";")[0].split("=")[1];
}

async function tabFor(email: string): Promise<Page> {
  const context = await browser.newContext({ viewport: { width: 1440, height: 900 } });
  await context.addCookies([{ name: "redline_session", value: await cookieOf(email), url: server.url }]);
  return context.newPage();
}

beforeAll(async () => {
  webDir = mkdtempSync(join(tmpdir(), "redline-web-"));
  dataDir = mkdtempSync(join(tmpdir(), "redline-counters-"));
  copyBuiltWeb(webDir);
  server = await startServer({ dataDir, port: 0, artboardPort: 0, host: "127.0.0.1", webDir, authMode: "local", log: (line) => (setupLink = line.slice(line.indexOf("http"))) });
  const token = setupLink.split("/#/setup/")[1].trim();
  await fetch(`${server.url}/api/setup`, { method: "POST", headers: JSON_HEADERS, body: JSON.stringify({ token, name: "Vincent Peraud", email: "vincent@example.com", password: PASSWORD }) });
  const db = new Database(join(dataDir, "redline.db"));
  const hash = await hashPassword(PASSWORD);
  db.prepare("INSERT INTO people (id, name, email, created_at, role, status, password_hash, origin) VALUES (?, ?, ?, ?, 'member', 'active', ?, 'local')").run(randomUUID(), "Ariane Martin", ARIANE, new Date().toISOString(), hash);
  db.close();
  browser = await launchBrowser();
}, 60_000);

afterAll(async () => {
  await browser?.close();
  await server?.close();
  rmSync(webDir, { recursive: true, force: true });
  rmSync(dataDir, { recursive: true, force: true });
});

const FILES = { "home.html": "<h1>Home</h1>", [MANIFEST_PATH]: JSON.stringify({ artboards: [{ file: "home.html", x: 0, y: 0, width: 400, height: 300 }] }) };

async function apiAs(email: string, method: string, path: string, body?: unknown): Promise<Response> {
  const cookie = `redline_session=${await cookieOf(email)}`;
  return fetch(server.url + path, { method, headers: { ...JSON_HEADERS, cookie }, body: method === "GET" ? undefined : JSON.stringify(body ?? {}) });
}

/** What `redline mcp` does for an account: presence, then pending_comments. */
async function conversation(email: string, folder: string) {
  const { token } = (await (await apiAs(email, "GET", "/api/agent-token")).json()) as AgentTokenResponse;
  const sessionId = randomUUID();
  const call = (path: string, body: unknown) => fetch(`${server.url}/agent-api${path}`, { method: "POST", headers: { authorization: `Bearer ${token}`, ...JSON_HEADERS }, body: JSON.stringify(body) });
  await call(`/terminal-sessions/${sessionId}/heartbeat`, { folder, machine: "MacBook-Air" });
  return { take: (pageId: string) => call(`/terminal-sessions/${sessionId}/take`, { pageId }) };
}

const post = async (pageId: string, body: string) =>
  (await (await apiAs(ARIANE, "POST", `/api/pages/${pageId}/threads`, { target: { kind: "artboard", artboard: "home.html" }, body })).json()) as Thread;

it("shows the threads to take next to the open threads, in the overview and the page menu, and updates them live", async () => {
  const project = (await (await apiAs(ARIANE, "POST", "/api/projects", { title: "Agora" })).json()) as Project;
  const newPage = async (title: string) => ((await (await apiAs(ARIANE, "POST", `/api/projects/${project.id}/pages`, { title, files: FILES })).json()) as { id: string }).id;
  const share = await newPage("Partager");
  const quiet = await newPage("Connexion");
  await post(share, "Un");
  await post(share, "Deux");

  const tab = await tabFor(ARIANE);
  await tab.goto(`${server.url}/#/projects/${project.id}`);
  const card = (title: string) => tab.locator("[data-testid=page-card]", { hasText: title });
  const summary = () => tab.getByTestId("project-summary").innerText();
  await expect.poll(() => card("Partager").getByTestId("to-take-badge").innerText()).toBe("2 à prendre");
  expect(await card("Partager").innerText()).toContain("2 fils");
  expect(await card("Connexion").getByTestId("to-take-badge").count()).toBe(0);
  await expect.poll(summary).toMatch(/2 fils ouverts · 2 à prendre$/);

  // A thread posted meanwhile shows up live.
  await post(quiet, "Trois");
  await expect.poll(summary).toMatch(/3 fils ouverts · 3 à prendre$/);

  // A take empties the badge but keeps the open thread.
  await (await conversation(ARIANE, "/Users/ariane/claude-projects/redline")).take(share);
  await expect.poll(summary).toMatch(/3 fils ouverts · 1 à prendre$/);
  await expect.poll(() => card("Partager").getByTestId("to-take-badge").count()).toBe(0);
  expect(await card("Partager").innerText()).toContain("2 fils");

  // The page menu of the canvas carries the same badge.
  await tab.goto(`${server.url}/#/pages/${share}`);
  await tab.getByRole("button", { name: /Partager/ }).first().click();
  const menu = tab.getByRole("menu").first();
  await expect.poll(() => menu.getByRole("menuitem", { name: /Connexion/ }).getByTestId("to-take-badge").innerText()).toBe("1 à prendre");
  expect(await menu.getByRole("menuitem", { name: /Partager/ }).getByTestId("to-take-badge").count()).toBe(0);
  await tab.close();
}, 90_000);
