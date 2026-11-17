import Database from "better-sqlite3";
import { randomUUID } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import WebSocket from "ws";
import { copyBuiltWeb } from "./builtWeb.js";
import type { Browser, Locator, Page } from "playwright";
import { afterAll, afterEach, beforeAll, expect, it } from "vitest";
import { AGENT_ENDPOINT, MANIFEST_PATH, PROTOCOL_VERSION, type AgentTokenResponse, type Project, type Thread } from "@redline/shared";
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
  dataDir = mkdtempSync(join(tmpdir(), "redline-hand-over-"));
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

const agents: WebSocket[] = [];
afterEach(() => {
  for (const socket of agents.splice(0)) socket.close();
});

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

/** An agent of Ariane online for the project: it receives the work it is sent and never answers. */
async function startAgent(projectId: string): Promise<void> {
  const { token } = (await (await apiAs(ARIANE, "GET", "/api/agent-token")).json()) as AgentTokenResponse;
  const socket = new WebSocket(server.url.replace(/^http/, "ws") + AGENT_ENDPOINT);
  agents.push(socket);
  await new Promise<void>((resolve, reject) => socket.on("open", () => resolve()).on("error", reject));
  const hello = new Promise<void>((resolve) => socket.once("message", () => resolve()));
  socket.send(JSON.stringify({ type: "hello", token, protocolVersion: PROTOCOL_VERSION, machine: "m", folder: "/f", kind: "project", projectIds: [projectId] }));
  await hello;
}

async function sharedPage() {
  const project = (await (await apiAs(ARIANE, "POST", "/api/projects", { title: "Agora" })).json()) as Project;
  const db = new Database(join(dataDir, "redline.db"), { readonly: true });
  const thomasId = (db.prepare("SELECT id FROM people WHERE email = ?").get(THOMAS) as { id: string }).id;
  db.close();
  await apiAs(ARIANE, "PUT", `/api/projects/${project.id}/members/${thomasId}`, { level: "write" });
  const page = (await (await apiAs(ARIANE, "POST", `/api/projects/${project.id}/pages`, { title: "Partager", files: FILES })).json()) as { id: string };
  const post = async (email: string, body: string) => (await (await apiAs(email, "POST", `/api/pages/${page.id}/threads`, { target: { kind: "artboard", artboard: "home.html" }, body })).json()) as Thread;
  return { projectId: project.id, pageId: page.id, post };
}

const commentsOf = async (email: string, pageId: string, viewport?: { width: number; height: number }) => {
  const tab = await tabFor(email);
  if (viewport) await tab.setViewportSize(viewport);
  await tab.goto(`${server.url}/#/pages/${pageId}`);
  await tab.getByRole("tab", { name: /^Commentaires/ }).click();
  return tab;
};

const button = (card: Locator, name: string) => card.getByRole("button", { name, exact: true });

it("disables Confier à l'agent with the reason and a link to the Agents page while no agent runs", async () => {
  const { pageId, post } = await sharedPage();
  const thread = await post(ARIANE, "Le titre devrait reprendre le nom de la page.");
  const tab = await commentsOf(ARIANE, pageId);
  const card = tab.locator(`[data-thread="${thread.id}"]`);

  await expect.poll(() => button(card, "Confier à l'agent").isDisabled()).toBe(true);
  expect(await card.getByTestId("hand-over-why").innerText()).toBe("Aucun agent ne tourne : lance-en un depuis la page Agents");
  expect(await card.getByTestId("hand-over-why").getByRole("link").getAttribute("href")).toBe("#/agents");
  await tab.close();
}, 60_000);

it("hands a thread to take over to the agent: it shows Agent du projet and the line of who handed it", async () => {
  const { projectId, pageId, post } = await sharedPage();
  await startAgent(projectId);
  const thread = await post(ARIANE, "Le titre devrait reprendre le nom de la page.");
  const tab = await commentsOf(ARIANE, pageId);
  const card = tab.locator(`[data-thread="${thread.id}"]`);
  await expect.poll(() => button(card, "Confier à l'agent").isEnabled()).toBe(true);

  await button(card, "Confier à l'agent").click();

  await expect.poll(() => card.getByTestId("thread-handler").innerText()).toBe("Agent du projet");
  expect(await card.getByTestId("thread-system").innerText()).toBe("Confié à l'agent par Ariane Martin");
  expect(await button(card, "Confier à l'agent").count()).toBe(0);
  await tab.close();
}, 60_000);

it("asks before handing over a thread taken by someone else, then keeps the line and the late reply of their conversation", async () => {
  const { projectId, pageId, post } = await sharedPage();
  await startAgent(projectId);
  const thread = await post(ARIANE, "Ajoute une option pour que le lien expire.");
  const thomas = await conversation(THOMAS, "/Users/thomas/crm");
  await thomas.take(pageId);
  const tab = await commentsOf(ARIANE, pageId);
  const card = tab.locator(`[data-thread="${thread.id}"]`);
  await expect.poll(() => card.getByTestId("thread-handler").innerText()).toBe("Pris par Thomas Lefevre");
  expect(await button(card, "Libérer").count()).toBe(0);

  await button(card, "Confier à l'agent").click();
  const dialog = tab.getByRole("dialog", { name: "Confier à l'agent un fil pris par Thomas Lefevre" });
  await expect.poll(() => dialog.innerText()).toContain("Une conversation de Thomas Lefevre a pris ce fil à l'instant (~/crm, MacBook-Air). Si tu le confies à l'agent, il le traitera ; une réponse de sa conversation sera encore ajoutée au fil, signée. Le fil indiquera « confié à l'agent par Ariane Martin ».");
  await dialog.getByRole("button", { name: "Annuler" }).click();
  await expect.poll(() => dialog.count()).toBe(0);
  expect(await card.getByTestId("thread-handler").innerText()).toBe("Pris par Thomas Lefevre");

  await button(card, "Confier à l'agent").click();
  await dialog.getByRole("button", { name: "Confier à l'agent" }).click();
  await expect.poll(() => card.getByTestId("thread-handler").innerText()).toBe("Agent du projet");
  expect(await card.getByTestId("thread-system").innerText()).toBe("Pris par Thomas Lefevre, puis confié à l'agent par Ariane Martin");

  await thomas.reply(thread.id, "Option d'expiration ajoutée.");
  await expect.poll(() => card.getByTestId("reply").innerText()).toContain("après le transfert");
  expect(await card.getByTestId("thread-handler").innerText()).toBe("Agent du projet");
  await tab.close();
}, 90_000);

it("offers Libérer only to the account that took the thread, and the thread is to take again", async () => {
  const { pageId, post } = await sharedPage();
  const thread = await post(ARIANE, "Il n'y a pas d'écran qui liste les liens.");
  await (await conversation(THOMAS, "/Users/thomas/crm")).take(pageId);
  const arianeTab = await commentsOf(ARIANE, pageId);
  const thomasTab = await commentsOf(THOMAS, pageId);
  const arianeCard = arianeTab.locator(`[data-thread="${thread.id}"]`);
  const thomasCard = thomasTab.locator(`[data-thread="${thread.id}"]`);
  await expect.poll(() => thomasCard.getByTestId("thread-handler").innerText()).toBe("Pris par toi");
  await expect.poll(() => arianeCard.getByTestId("thread-handler").innerText()).toBe("Pris par Thomas Lefevre");
  expect(await button(arianeCard, "Libérer").count()).toBe(0);

  await button(thomasCard, "Libérer").click();

  await expect.poll(() => thomasCard.getByTestId("thread-handler").innerText()).toBe("À prendre");
  await expect.poll(() => arianeCard.getByTestId("thread-handler").innerText()).toBe("À prendre");
  expect(await button(thomasCard, "Libérer").count()).toBe(0);
  await arianeTab.close();
  await thomasTab.close();
}, 90_000);

it("says a conversation just took the thread when Confier à l'agent loses the race, and Voir et confier opens the confirmation", async () => {
  const { projectId, pageId, post } = await sharedPage();
  await startAgent(projectId);
  const thread = await post(ARIANE, "Mets le bouton Copier en premier.");
  const tab = await commentsOf(ARIANE, pageId);
  const card = tab.locator(`[data-thread="${thread.id}"]`);
  await expect.poll(() => button(card, "Confier à l'agent").isEnabled()).toBe(true);
  const thomas = await conversation(THOMAS, "/Users/thomas/crm");
  await tab.route("**/hand-over", async (route) => {
    await thomas.take(pageId);
    await route.continue();
  });

  await button(card, "Confier à l'agent").click();

  const toast = tab.getByTestId("toast").filter({ hasText: "vient de prendre ce fil" });
  await expect.poll(() => toast.innerText()).toContain("Une conversation de Thomas Lefevre vient de prendre ce fil.");
  await toast.getByRole("button", { name: "Voir et confier" }).click();
  const dialog = tab.getByRole("dialog", { name: "Confier à l'agent un fil pris par Thomas Lefevre" });
  await expect.poll(() => dialog.count()).toBe(1);
  await tab.unroute("**/hand-over");
  await dialog.getByRole("button", { name: "Confier à l'agent" }).click();
  await expect.poll(() => card.getByTestId("thread-handler").innerText()).toBe("Agent du projet");
  await tab.close();
}, 90_000);

it("tells a failed hand-over with its reason and retries it", async () => {
  const { projectId, pageId, post } = await sharedPage();
  await startAgent(projectId);
  const thread = await post(ARIANE, "Mets le bouton Copier en premier.");
  const tab = await commentsOf(ARIANE, pageId);
  const card = tab.locator(`[data-thread="${thread.id}"]`);
  await expect.poll(() => button(card, "Confier à l'agent").isEnabled()).toBe(true);
  await tab.route("**/hand-over", (route) => route.abort());

  await button(card, "Confier à l'agent").click();

  const toast = tab.getByRole("alert").filter({ hasText: "n'a pas pu être confié" });
  await expect.poll(() => toast.innerText()).toContain("Le fil n'a pas pu être confié à l'agent : connexion perdue.");
  expect(await card.getByTestId("thread-handler").innerText()).toBe("À prendre");
  await tab.unroute("**/hand-over");
  await toast.getByRole("button", { name: "Réessayer" }).click();
  await expect.poll(() => card.getByTestId("thread-handler").innerText()).toBe("Agent du projet");
  await tab.close();
}, 90_000);

it("shows Question de Claude to the others when the taker's conversation answered and left the thread open", async () => {
  const { pageId, post } = await sharedPage();
  const thread = await post(ARIANE, "Il n'y a pas d'écran qui liste les liens.");
  const thomas = await conversation(THOMAS, "/Users/thomas/crm");
  await thomas.take(pageId);
  await thomas.reply(thread.id, "C'est un nouvel écran : je ne le dessine pas sans décision.");
  const tab = await commentsOf(ARIANE, pageId);
  const card = tab.locator(`[data-thread="${thread.id}"]`);

  await expect.poll(() => card.getByTestId("thread-handler").innerText()).toBe("Question de Claude");
  expect(await card.getByTestId("thread-taken").innerText()).toBe("Ta réponse ira à une conversation de Thomas Lefevre, qui a pris ce fil");
  await tab.close();
}, 60_000);

it("stacks the card buttons full width, 44 px high, on a phone", async () => {
  const { projectId, pageId, post } = await sharedPage();
  await startAgent(projectId);
  const thread = await post(ARIANE, "Le titre devrait reprendre le nom de la page.");
  const tab = await commentsOf(ARIANE, pageId, { width: 390, height: 844 });
  const card = tab.locator(`[data-thread="${thread.id}"]`);
  await expect.poll(() => button(card, "Confier à l'agent").isEnabled()).toBe(true);

  const confier = (await button(card, "Confier à l'agent").boundingBox())!;
  const repondre = (await button(card, "Répondre").boundingBox())!;
  const resoudre = (await button(card, "Résoudre").boundingBox())!;
  const cardBox = (await card.boundingBox())!;

  for (const box of [confier, repondre, resoudre]) expect(box.height).toBeGreaterThanOrEqual(44);
  expect(confier.width).toBeGreaterThan(cardBox.width - 40);
  expect(repondre.y).toBeGreaterThan(confier.y + confier.height - 1);
  expect(Math.abs(repondre.y - resoudre.y)).toBeLessThan(2);
  await tab.close();
}, 60_000);
