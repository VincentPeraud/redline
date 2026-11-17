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
const THOMAS = "thomas@example.com";

let webDir: string;
let dataDir: string;
let browser: Browser;
let server: RunningServer;
let setupLink = "";
const ids: Record<string, string> = {};

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
  dataDir = mkdtempSync(join(tmpdir(), "redline-traces-"));
  copyBuiltWeb(webDir);
  server = await startServer({ dataDir, port: 0, artboardPort: 0, host: "127.0.0.1", webDir, authMode: "local", log: (line) => (setupLink = line.slice(line.indexOf("http"))) });
  const token = setupLink.split("/#/setup/")[1].trim();
  await fetch(`${server.url}/api/setup`, { method: "POST", headers: JSON_HEADERS, body: JSON.stringify({ token, name: "Vincent Peraud", email: "vincent@example.com", password: PASSWORD }) });
  const db = new Database(join(dataDir, "redline.db"));
  const hash = await hashPassword(PASSWORD);
  for (const [name, email] of [["Ariane Martin", ARIANE], ["Thomas Lefevre", THOMAS]]) {
    ids[email] = randomUUID();
    db.prepare("INSERT INTO people (id, name, email, created_at, role, status, password_hash, origin) VALUES (?, ?, ?, ?, 'member', 'active', ?, 'local')").run(ids[email], name, email, new Date().toISOString(), hash);
  }
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

async function conversation(email: string, folder: string) {
  const { token } = (await (await apiAs(email, "GET", "/api/agent-token")).json()) as AgentTokenResponse;
  const sessionId = randomUUID();
  const call = (path: string, body: unknown) => fetch(`${server.url}/agent-api${path}`, { method: "POST", headers: { authorization: `Bearer ${token}`, ...JSON_HEADERS }, body: JSON.stringify(body) });
  await call(`/terminal-sessions/${sessionId}/heartbeat`, { folder, machine: "MacBook-Air" });
  return {
    take: (pageId: string) => call(`/terminal-sessions/${sessionId}/take`, { pageId }),
    reply: (threadId: string, body: string, resolve?: boolean) => call(`/threads/${threadId}/replies`, { body, terminalSessionId: sessionId, ...(resolve ? { resolve } : {}) }),
  };
}

/** A page of Ariane's project (Thomas writes in it) with a thread taken by Ariane's conversation, which answered once. */
async function takenThread() {
  const project = (await (await apiAs(ARIANE, "POST", "/api/projects", { title: "Agora" })).json()) as Project;
  await apiAs(ARIANE, "PUT", `/api/projects/${project.id}/members/${ids[THOMAS]}`, { level: "write" });
  const page = (await (await apiAs(ARIANE, "POST", `/api/projects/${project.id}/pages`, { title: "Partager", files: FILES })).json()) as { id: string };
  const thread = (await (await apiAs(ARIANE, "POST", `/api/pages/${page.id}/threads`, { target: { kind: "artboard", artboard: "home.html" }, body: "Ajoute une option pour que le lien expire." })).json()) as Thread;
  const arianes = await conversation(ARIANE, "/Users/ariane/crm");
  await arianes.take(page.id);
  return { pageId: page.id, thread, arianes };
}

/** What the hand-over and takeover routes will do: written in the database, as those tickets will through the store. */
function write(sql: string, ...values: unknown[]) {
  const db = new Database(join(dataDir, "redline.db"));
  db.prepare(sql).run(...values);
  db.close();
}

const open = async (email: string, pageId: string) => {
  const tab = await tabFor(email);
  await tab.goto(`${server.url}/#/pages/${pageId}`);
  await tab.getByRole("tab", { name: /^Commentaires/ }).click();
  return tab;
};

it("shows the system line of a hand-over, then the late answer signed after the transfer, replies indented with Claude in the accent colour", async () => {
  const { pageId, thread, arianes } = await takenThread();
  write("UPDATE threads SET taken_by = NULL, taken_folder = NULL, taken_machine = NULL, taken_at = NULL, session_id = 's', agent_id = 'a' WHERE id = ?", thread.id);
  write("INSERT INTO thread_traces (id, thread_id, kind, taker_id, by_id, created_at) VALUES (?, ?, 'handed-over', ?, ?, ?)", randomUUID(), thread.id, ids[ARIANE], ids[THOMAS], new Date().toISOString());
  await arianes.reply(thread.id, "Option d'expiration ajoutée : 7, 30 ou 90 jours.");

  const tab = await open(THOMAS, pageId);
  const card = tab.locator(`[data-thread="${thread.id}"]`);

  expect(await card.getByTestId("thread-system").innerText()).toBe("Pris par Ariane Martin, puis confié à l'agent par Thomas Lefevre");
  const reply = card.getByTestId("reply");
  expect(await reply.locator("small").innerText()).toBe("· conversation de Ariane Martin · ~/crm · après le transfert");
  // The line sits between the comment and the late answer.
  const order = await card.locator("[data-testid=thread-system], [data-testid=reply]").evaluateAll((nodes) => nodes.map((node) => node.getAttribute("data-testid")));
  expect(order).toEqual(["thread-system", "reply"]);
  const style = await reply.evaluate((node) => {
    const css = getComputedStyle(node);
    const author = getComputedStyle(node.querySelector("[data-testid=message-author]")!);
    return { border: css.borderLeftWidth, marginLeft: css.marginLeft, background: css.backgroundColor, author: author.color };
  });
  expect(style.border).toBe("2px");
  expect(style.marginLeft).toBe("12px");
  expect(style.background).toBe("rgba(0, 0, 0, 0)");
  expect(style.author).not.toBe("rgb(24, 24, 27)");
  await tab.close();
}, 90_000);

it("shows \"puis repris par\" after a takeover", async () => {
  const { pageId, thread } = await takenThread();
  write("UPDATE threads SET taken_by = ? WHERE id = ?", ids[THOMAS], thread.id);
  write("INSERT INTO thread_traces (id, thread_id, kind, taker_id, by_id, created_at) VALUES (?, ?, 'taken-over', ?, ?, ?)", randomUUID(), thread.id, ids[ARIANE], ids[THOMAS], new Date().toISOString());

  const tab = await open(THOMAS, pageId);

  expect(await tab.locator(`[data-thread="${thread.id}"]`).getByTestId("thread-system").innerText()).toBe("Pris par Ariane Martin, puis repris par Thomas Lefevre");
  await tab.close();
}, 60_000);

it("folds a thread resolved by someone else into \"Résolu par <person> · <first words>\", live, and keeps the late answer inside", async () => {
  const { pageId, thread, arianes } = await takenThread();
  const tab = await open(ARIANE, pageId);
  await tab.locator(`[data-thread="${thread.id}"]`).waitFor();

  await apiAs(THOMAS, "POST", `/api/threads/${thread.id}/resolve`);
  const row = tab.getByRole("button", { name: /^Résolu par Thomas Lefevre · Ajoute une option/ });
  await row.waitFor();
  expect(await row.getAttribute("aria-expanded")).toBe("false");

  await arianes.reply(thread.id, "Trop tard, mais voici la liste.");
  await row.click();
  const card = tab.locator(`[data-thread="${thread.id}"]`);
  expect(await card.getByTestId("thread-system").innerText()).toBe("Résolu par Thomas Lefevre");
  expect(await card.getByTestId("reply").locator("small").innerText()).toBe("· conversation de Ariane Martin · ~/crm · après la résolution");
  await tab.close();
}, 90_000);
