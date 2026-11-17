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


/** A page in Conversation mode of a project where Thomas has `level`, with a thread of Ariane and a thread of Thomas (Thomas needs Écriture to post at that level). */
async function sharedPage(thomasLevel: "write" | "comment") {
  const project = (await (await apiAs(ARIANE, "POST", "/api/projects", { title: "Agora" })).json()) as Project;
  const db = new Database(join(dataDir, "redline.db"), { readonly: true });
  const thomasId = (db.prepare("SELECT id FROM people WHERE email = ?").get(THOMAS) as { id: string }).id;
  db.close();
  await apiAs(ARIANE, "PUT", `/api/projects/${project.id}/members/${thomasId}`, { level: "write" });
  const page = (await (await apiAs(ARIANE, "POST", `/api/projects/${project.id}/pages`, { title: "Partager", files: FILES })).json()) as { id: string };
  const post = async (email: string, body: string) => (await (await apiAs(email, "POST", `/api/pages/${page.id}/threads`, { target: { kind: "artboard", artboard: "home.html" }, body })).json()) as Thread;
  const threads = { ariane: await post(ARIANE, "Le titre devrait reprendre le nom de la page."), thomas: await post(THOMAS, "Ajoute une option pour que le lien expire."), third: await post(ARIANE, "Le bouton est trop petit.") };
  if (thomasLevel !== "write") await apiAs(ARIANE, "PUT", `/api/projects/${project.id}/members/${thomasId}`, { level: thomasLevel });
  return { pageId: page.id, threads, post };
}

const commentsOf = async (email: string, pageId: string) => {
  const tab = await tabFor(email);
  await tab.goto(`${server.url}/#/pages/${pageId}`);
  await tab.getByRole("tab", { name: /^Commentaires/ }).click();
  return tab;
};

it("counts the threads in the confirmation: the threads to take wait for the offline agent, the taken ones, by whoever took them, stay", async () => {
  const { pageId, post } = await sharedPage("write");
  await (await conversation(THOMAS, "/Users/thomas/crm")).take(pageId);
  await post(ARIANE, "Mets le bouton en premier.");
  await (await conversation(ARIANE, "/Users/ariane/claude-projects/redline")).take(pageId);
  await post(THOMAS, "Le bouton est caché par le clavier.");
  const tab = await commentsOf(ARIANE, pageId);
  await expect.poll(() => tab.locator('[data-handler="other"]').count()).toBe(3);
  expect(await tab.locator('[data-handler="mine"]').count()).toBe(1);

  await tab.getByTestId("comment-mode").getByRole("button", { name: "Agent" }).click();
  const dialog = tab.getByRole("dialog", { name: "Passer la page en mode Agent" });
  await expect.poll(() => dialog.textContent()).toContain("L'agent du projet ne tourne pas.");
  expect(await dialog.textContent()).toContain("1fil à prendre passe en attente de l'agent.");
  expect(await dialog.textContent()).toContain("4fils pris (par Thomas Lefevre et par toi) restent à leur preneur.");
  await tab.close();
}, 90_000);

it("tells the other viewers of the page, live, who changed the mode, and shows the new mode on their toggle and hint", async () => {
  const { pageId } = await sharedPage("write");
  const ariane = await commentsOf(ARIANE, pageId);
  const thomas = await commentsOf(THOMAS, pageId);
  await expect.poll(() => thomas.getByTestId("comment-hint").textContent()).toContain("3 commentaires à prendre.");

  await ariane.getByTestId("comment-mode").getByRole("button", { name: "Agent" }).click();
  await ariane.getByRole("button", { name: "Passer en mode Agent" }).click();

  const toast = thomas.getByRole("status").filter({ hasText: "a passé la page en mode Agent" });
  await expect.poll(() => toast.textContent()).toBe("Ariane Martin a passé la page en mode Agent : les nouveaux commentaires partent à l'agent.");
  expect(await thomas.getByTestId("comment-mode").locator("button[aria-pressed='true']").textContent()).toContain("Agent");
  await expect.poll(() => thomas.getByTestId("comment-hint").textContent()).toContain("Mode Agent.");
  expect(await ariane.getByRole("status").filter({ hasText: "a passé la page" }).count()).toBe(0);
  await ariane.close();
  await thomas.close();
}, 90_000);

it("shows the toggle disabled to a member with Commentaire, with the reason, and a hint that does not ask them to do anything", async () => {
  const { pageId } = await sharedPage("comment");
  const tab = await commentsOf(THOMAS, pageId);
  const toggle = tab.getByTestId("comment-mode");

  expect(await toggle.getByRole("button", { name: "Agent" }).isDisabled()).toBe(true);
  expect(await toggle.getByRole("button", { name: "Conversation" }).isDisabled()).toBe(true);
  await expect.poll(() => tab.getByTestId("comment-hint").textContent()).toContain("3 commentaires à prendre. Les membres en Écriture les traitent avec Claude.");

  await toggle.getByRole("button", { name: "Commentaires", exact: true }).click();
  const popover = tab.getByRole("dialog", { name: "Qui traite les commentaires" });
  await expect.poll(() => popover.textContent()).toContain("Seuls les membres en Écriture et les admins changent ce réglage. Tu as le droit Commentaire.");
  await tab.close();
}, 90_000);

it("keeps an error toast until it is closed, and retries from it", async () => {
  const { pageId } = await sharedPage("write");
  const tab = await commentsOf(ARIANE, pageId);
  let fail = true;
  await tab.route("**/api/pages/*/comment-mode", (route) => (fail ? route.abort("connectionreset") : route.continue()));

  await tab.getByTestId("comment-mode").getByRole("button", { name: "Agent" }).click();
  await tab.getByRole("button", { name: "Passer en mode Agent" }).click();
  const toast = tab.getByRole("alert").filter({ hasText: "Le mode n'a pas pu être changé" });
  await expect.poll(() => toast.textContent()).toContain("connexion perdue");
  await new Promise((resolve) => setTimeout(resolve, 7_000));
  expect(await toast.count()).toBe(1);

  fail = false;
  await toast.getByRole("button", { name: "Réessayer" }).click();
  await expect.poll(() => tab.getByTestId("comment-mode").locator("button[aria-pressed='true']").textContent()).toContain("Agent");
  await expect.poll(() => toast.count()).toBe(0);
  await tab.close();
}, 90_000);
