import Database from "better-sqlite3";
import { randomUUID } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { build } from "vite";
import type { Browser, Page } from "playwright";
import { afterAll, beforeAll, expect, it } from "vitest";
import { MANIFEST_PATH, type Project } from "@redline/shared";
import { hashPassword } from "../../server/src/accounts.js";
import { startServer, type RunningServer } from "../../server/src/start.js";
import { launchBrowser } from "./journeyBrowser.js";

const webRoot = fileURLToPath(new URL("..", import.meta.url));
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

beforeAll(async () => {
  webDir = mkdtempSync(join(tmpdir(), "redline-web-"));
  dataDir = mkdtempSync(join(tmpdir(), "redline-review-"));
  await build({ root: webRoot, logLevel: "silent", build: { outDir: webDir, emptyOutDir: true } });
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

async function apiAs(email: string, method: string, path: string, body?: unknown): Promise<Response> {
  const cookie = `redline_session=${await cookieOf(email)}`;
  return fetch(server.url + path, { method, headers: { ...JSON_HEADERS, cookie }, body: method === "GET" ? undefined : JSON.stringify(body ?? {}) });
}

async function projectWithPage(title: string): Promise<{ project: Project; pageId: string }> {
  const project = (await (await apiAs("ariane@example.com", "POST", "/api/projects", { title })).json()) as Project;
  const page = (await (await apiAs("ariane@example.com", "POST", `/api/projects/${project.id}/pages`, { title: "Home", files: FILES })).json()) as { id: string };
  return { project, pageId: page.id };
}


it("shows À relire threads with a counter, sends one to Claude from the card, and keeps the Commentaire member from sending", async () => {
  const { project, pageId } = await projectWithPage("Agora");
  const db = new Database(join(dataDir, "redline.db"));
  const thomasId = (db.prepare("SELECT id FROM people WHERE email = 'thomas@example.com'").get() as { id: string }).id;
  db.close();
  await apiAs("ariane@example.com", "PUT", `/api/projects/${project.id}/members/${thomasId}`, { level: "comment" });
  const post = (body: string) => apiAs("thomas@example.com", "POST", `/api/pages/${pageId}/threads`, { target: { kind: "artboard", artboard: "home.html" }, body });
  await post("Le bouton est trop petit sur téléphone.");
  await post("Le filtre devrait être sélectionné par défaut.");

  const thomas = await tabFor("thomas@example.com");
  await thomas.goto(`${server.url}/#/pages/${pageId}`);
  await thomas.getByRole("tab", { name: /Commentaires/ }).click();
  const thomasBar = thomas.getByTestId("review-bar");
  await thomasBar.waitFor();
  expect(await thomasBar.innerText()).toContain("2 commentaires à relire");
  expect(await thomas.getByRole("button", { name: "Envoyer à Claude", exact: true }).count()).toBe(0);
  expect(await thomas.getByRole("button", { name: "Tout envoyer à Claude" }).count()).toBe(0);

  const ariane = await tabFor("ariane@example.com");
  await ariane.goto(`${server.url}/#/pages/${pageId}`);
  await ariane.getByRole("tab", { name: /Commentaires/ }).click();
  const bar = ariane.getByTestId("review-bar");
  await bar.waitFor();
  expect(await bar.innerText()).toContain("2 commentaires à relire");
  expect(await ariane.getByText("À relire", { exact: true }).count()).toBe(2);
  await ariane.getByRole("button", { name: "Envoyer à Claude", exact: true }).first().click();
  await expect.poll(() => bar.innerText(), { timeout: 10_000 }).toContain("1 commentaire à relire");
  await ariane.getByRole("button", { name: "Résoudre" }).first().click();
  await bar.waitFor({ state: "detached" });
  const statuses = ((await (await apiAs("ariane@example.com", "GET", `/api/pages/${pageId}/threads`)).json()) as { status: string }[]).map((t) => t.status);
  expect(statuses).toEqual(["open", "resolved"]);
}, 90_000);
