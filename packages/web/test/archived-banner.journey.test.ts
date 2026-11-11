import Database from "better-sqlite3";
import { randomUUID } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { copyBuiltWeb } from "./builtWeb.js";
import type { Browser, Page } from "playwright";
import { afterAll, beforeAll, expect, it } from "vitest";
import { MANIFEST_PATH, type Project } from "@redline/shared";
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

beforeAll(async () => {
  webDir = mkdtempSync(join(tmpdir(), "redline-web-"));
  dataDir = mkdtempSync(join(tmpdir(), "redline-archived-banner-"));
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

async function apiAs(email: string, method: string, path: string, body?: unknown): Promise<Response> {
  const cookie = `redline_session=${await cookieOf(email)}`;
  return fetch(server.url + path, { method, headers: { ...JSON_HEADERS, cookie }, body: method === "GET" ? undefined : JSON.stringify(body ?? {}) });
}

async function projectWithPage(title: string): Promise<{ project: Project; pageId: string }> {
  const project = (await (await apiAs("ariane@example.com", "POST", "/api/projects", { title })).json()) as Project;
  const page = (await (await apiAs("ariane@example.com", "POST", `/api/projects/${project.id}/pages`, { title: "Home", files: FILES })).json()) as { id: string };
  return { project, pageId: page.id };
}


it("offers Désarchiver to the creator of an archived project, not to a member in Écriture", async () => {
  const { project, pageId } = await projectWithPage("Agora");
  await apiAs("ariane@example.com", "POST", `/api/projects/${project.id}/archive`, {});

  const thomas = await tabFor("thomas@example.com");
  await thomas.goto(`${server.url}/#/projects/${project.id}`);
  await thomas.getByRole("status").filter({ hasText: "Archivé" }).waitFor();
  expect(await thomas.getByRole("button", { name: "Désarchiver" }).count()).toBe(0);

  const ariane = await tabFor("ariane@example.com");
  await ariane.goto(`${server.url}/#/projects/${project.id}`);
  await ariane.getByRole("button", { name: "Désarchiver" }).waitFor();

  // The canvas banner follows the same rule.
  await thomas.goto(`${server.url}/#/pages/${pageId}`);
  await thomas.getByRole("status").filter({ hasText: "Archivé" }).waitFor();
  expect(await thomas.getByRole("button", { name: "Désarchiver" }).count()).toBe(0);
}, 90_000);
