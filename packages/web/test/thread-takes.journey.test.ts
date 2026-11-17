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
  dataDir = mkdtempSync(join(tmpdir(), "redline-takes-"));
  copyBuiltWeb(webDir);
  server = await startServer({ dataDir, port: 0, artboardPort: 0, host: "127.0.0.1", webDir, authMode: "local", log: (line) => (setupLink = line.slice(line.indexOf("http"))) });
  const token = setupLink.split("/#/setup/")[1].trim();
  await fetch(`${server.url}/api/setup`, { method: "POST", headers: JSON_HEADERS, body: JSON.stringify({ token, name: "Vincent Peraud", email: "vincent@example.com", password: PASSWORD }) });
  const db = new Database(join(dataDir, "redline.db"));
  const hash = await hashPassword(PASSWORD);
  for (const [name, email] of [["Ariane Martin", ARIANE], ["Thomas Lefevre", THOMAS]]) {
    db.prepare("INSERT INTO people (id, name, email, created_at, role, status, password_hash, origin) VALUES (?, ?, ?, ?, 'member', 'active', ?, 'local')").run(randomUUID(), name, email, new Date().toISOString(), hash);
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

/** What `redline mcp` does for an account: presence, then pending_comments and reply_in_thread. */
async function conversation(email: string, folder: string) {
  const { token } = (await (await apiAs(email, "GET", "/api/agent-token")).json()) as AgentTokenResponse;
  const sessionId = randomUUID();
  const call = (path: string, body: unknown) => fetch(`${server.url}/agent-api${path}`, { method: "POST", headers: { authorization: `Bearer ${token}`, ...JSON_HEADERS }, body: JSON.stringify(body) });
  await call(`/terminal-sessions/${sessionId}/heartbeat`, { folder, machine: "MacBook-Air" });
  return {
    take: (pageId: string) => call(`/terminal-sessions/${sessionId}/take`, { pageId }),
    reply: (threadId: string, body: string) => call(`/threads/${threadId}/replies`, { body, terminalSessionId: sessionId }),
  };
}

async function sharedPage() {
  const project = (await (await apiAs(ARIANE, "POST", "/api/projects", { title: "Agora" })).json()) as Project;
  const db = new Database(join(dataDir, "redline.db"), { readonly: true });
  const thomasId = (db.prepare("SELECT id FROM people WHERE email = ?").get(THOMAS) as { id: string }).id;
  db.close();
  await apiAs(ARIANE, "PUT", `/api/projects/${project.id}/members/${thomasId}`, { level: "write" });
  const page = (await (await apiAs(ARIANE, "POST", `/api/projects/${project.id}/pages`, { title: "Partager", files: FILES })).json()) as { id: string };
  const post = async (email: string, body: string) => (await (await apiAs(email, "POST", `/api/pages/${page.id}/threads`, { target: { kind: "artboard", artboard: "home.html" }, body })).json()) as Thread;
  return { pageId: page.id, post };
}

const commentsOf = async (email: string, pageId: string) => {
  const tab = await tabFor(email);
  await tab.goto(`${server.url}/#/pages/${pageId}`);
  await tab.getByRole("tab", { name: /^Commentaires/ }).click();
  return tab;
};

it("shows a thread to take, then who took it, from where and since when, live, for the one who took it and for the others", async () => {
  const { pageId, post } = await sharedPage();
  const mine = await post(ARIANE, "Le titre devrait reprendre le nom de la page.");
  const tab = await commentsOf(ARIANE, pageId);
  const card = tab.locator(`[data-thread="${mine.id}"]`);

  await expect.poll(() => card.getByTestId("thread-handler").innerText()).toBe("À prendre");
  expect(await card.getByTestId("queued").count()).toBe(0);
  expect(await card.getByTestId("thread-taken").count()).toBe(0);

  const arianes = await conversation(ARIANE, "/Users/ariane/claude-projects/redline");
  await arianes.take(pageId);
  await expect.poll(() => card.getByTestId("thread-handler").innerText()).toBe("Pris par toi");
  expect(await card.getByTestId("thread-taken").innerText()).toMatch(/^Ta conversation l'a pris · ~\/claude-projects\/redline · à l'instant$/);

  const thomasTab = await commentsOf(THOMAS, pageId);
  const thomasCard = thomasTab.locator(`[data-thread="${mine.id}"]`);
  await expect.poll(() => thomasCard.getByTestId("thread-handler").innerText()).toBe("Pris par Ariane Martin");
  expect(await thomasCard.getByTestId("thread-taken").innerText()).toMatch(/^Une conversation de Ariane Martin l'a pris · ~\/claude-projects\/redline · MacBook-Air · à l'instant$/);

  // The conversation answers: the answer is signed with it and the take stays.
  await arianes.reply(mine.id, "Titre repris du nom de la page.");
  await expect.poll(() => card.getByTestId("reply").innerText()).toContain("Titre repris du nom de la page.");
  expect(await card.getByTestId("reply").locator("small").innerText()).toBe("· conversation de Ariane Martin · ~/claude-projects/redline");
  expect(await card.getByTestId("thread-handler").innerText()).toBe("Pris par toi");

  // A message from Thomas relaunches the thread for the account that took it.
  await apiAs(THOMAS, "POST", `/api/threads/${mine.id}/messages`, { body: "Il touche encore le bord." });
  await expect.poll(() => card.getByTestId("thread-handler").innerText()).toBe("Relance pour toi");
  expect(await card.getByTestId("thread-taken").innerText()).toBe("Attend une de tes conversations, qui avait pris ce fil");
  await expect.poll(() => thomasCard.getByTestId("thread-handler").innerText()).toBe("Relance pour Ariane Martin");
  expect(await thomasCard.getByTestId("thread-taken").innerText()).toBe("Attend une conversation de Ariane Martin, qui avait pris ce fil");

  // No trace of the old model: no terminal pill, no waiting-for-a-session label.
  expect(await tab.getByTestId("terminal-pill").count()).toBe(0);
  expect(await tab.getByText(/session terminal/i).count()).toBe(0);
  await tab.close();
  await thomasTab.close();
}, 90_000);

it("shows a thread an agent owns as it was: no handler on the card", async () => {
  const { pageId, post } = await sharedPage();
  await apiAs(ARIANE, "POST", `/api/pages/${pageId}/comment-mode`, { mode: "agent" });
  const thread = await post(ARIANE, "Mets le bouton en premier.");
  const tab = await commentsOf(ARIANE, pageId);

  await expect.poll(() => tab.locator(`[data-thread="${thread.id}"]`).getByTestId("queued").innerText()).toMatch(/En attente de l'agent/);
  expect(await tab.locator(`[data-thread="${thread.id}"]`).getByTestId("thread-handler").count()).toBe(0);
  await tab.close();
}, 60_000);
