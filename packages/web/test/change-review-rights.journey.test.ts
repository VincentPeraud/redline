import Database from "better-sqlite3";
import { randomUUID } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { copyBuiltWeb } from "./builtWeb.js";
import type { Browser, Page } from "playwright";
import { afterAll, beforeAll, expect, it } from "vitest";
import { MANIFEST_PATH, type AgentTokenResponse, type Project } from "@redline/shared";
import { hashPassword } from "../../server/src/accounts.js";
import { startServer, type RunningServer } from "../../server/src/start.js";
import { launchBrowser } from "./journeyBrowser.js";

const PASSWORD = "correct horse";
const JSON_HEADERS = { "content-type": "application/json" };

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
  const context = await browser.newContext();
  await context.addCookies([{ name: "redline_session", value: await cookieOf(email), url: server.url }]);
  return context.newPage();
}

async function apiAs(email: string, method: string, path: string, body?: unknown): Promise<Response> {
  const cookie = `redline_session=${await cookieOf(email)}`;
  return fetch(server.url + path, { method, headers: { ...JSON_HEADERS, cookie }, body: method === "GET" ? undefined : JSON.stringify(body ?? {}) });
}

beforeAll(async () => {
  webDir = mkdtempSync(join(tmpdir(), "redline-web-"));
  dataDir = mkdtempSync(join(tmpdir(), "redline-review-rights-"));
  copyBuiltWeb(webDir);
  server = await startServer({ dataDir, port: 0, artboardPort: 0, host: "127.0.0.1", webDir, authMode: "local", log: (line) => (setupLink = line.slice(line.indexOf("http"))) });
  const token = setupLink.split("/#/setup/")[1].trim();
  await fetch(`${server.url}/api/setup`, { method: "POST", headers: JSON_HEADERS, body: JSON.stringify({ token, name: "Vincent Peraud", email: "vincent@example.com", password: PASSWORD }) });
  const db = new Database(join(dataDir, "redline.db"));
  const hash = await hashPassword(PASSWORD);
  for (const [name, email] of [["Ariane Martin", "ariane@example.com"], ["Thomas Lefevre", "thomas@example.com"]]) {
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

/** Ariane declares a review of her project, as her terminal session does, with Thomas as a member at `level`. */
async function reviewWhereThomasIs(level: "read" | "comment"): Promise<string> {
  const project = (await (await apiAs("ariane@example.com", "POST", "/api/projects", { title: "Agora" })).json()) as Project;
  const page = (await (await apiAs("ariane@example.com", "POST", `/api/projects/${project.id}/pages`, { title: "Home", files: FILES })).json()) as { id: string };
  const db = new Database(join(dataDir, "redline.db"), { readonly: true });
  const thomasId = (db.prepare("SELECT id FROM people WHERE email = ?").get("thomas@example.com") as { id: string }).id;
  db.close();
  await apiAs("ariane@example.com", "PUT", `/api/projects/${project.id}/members/${thomasId}`, { level });
  const { token } = (await (await apiAs("ariane@example.com", "GET", "/api/agent-token")).json()) as AgentTokenResponse;
  const sessionId = randomUUID();
  const headers = { authorization: `Bearer ${token}`, ...JSON_HEADERS };
  await fetch(`${server.url}/agent-api/terminal-sessions/${sessionId}/heartbeat`, { method: "POST", headers, body: JSON.stringify({ folder: "/work/site", machine: "Mac" }) });
  const response = await fetch(`${server.url}/agent-api/terminal-sessions/${sessionId}/reviews`, {
    method: "POST",
    headers,
    body: JSON.stringify({ folder: "/work/site", steps: [{ pageId: page.id, artboard: "home.html", changed: "c", lookAt: "l", question: "q" }] }),
  });
  return ((await response.json()) as { id: string }).id;
}

it("shows the refusal screen, without the review title, to a member with Lecture or Commentaire", async () => {
  for (const level of ["read", "comment"] as const) {
    const reviewId = await reviewWhereThomasIs(level);
    const tab = await tabFor("thomas@example.com");
    await tab.goto(`${server.url}/#/reviews/${reviewId}`);

    await tab.getByRole("heading", { name: "Revue réservée aux membres de l'équipe en Écriture" }).waitFor();
    const screen = await tab.getByTestId("review").textContent();
    expect(screen, level).toContain("Ton accès à cette page (membre en Lecture ou Commentaire, ou lien de partage) ne permet pas de participer à la revue.");
    expect(screen, level).toContain("Tu peux toujours commenter les artboards depuis le canvas si ton accès le permet.");
    expect(await tab.getByTestId("review-top").textContent(), level).toBe("← CanvasRevue");
    expect(await tab.getByTestId("review-top").evaluate((node) => getComputedStyle(node).backgroundColor)).toBe("rgb(217, 45, 32)");
    await tab.getByRole("button", { name: "Retour au canvas" }).waitFor();
    await tab.context().close();
  }
});
