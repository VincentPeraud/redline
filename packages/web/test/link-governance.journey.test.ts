import Database from "better-sqlite3";
import { randomUUID } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { build } from "vite";
import type { Browser, Page } from "playwright";
import { afterAll, beforeAll, expect, it } from "vitest";
import { MANIFEST_PATH, type Project, type ShareLink } from "@redline/shared";
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
  dataDir = mkdtempSync(join(tmpdir(), "redline-link-governance-"));
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

async function linkAs(email: string, pageId: string, name: string, level: string): Promise<ShareLink> {
  const res = await apiAs(email, "POST", `/api/pages/${pageId}/links`, { kind: "personal", name, level });
  return (await res.json()) as ShareLink;
}

const works = async (link: ShareLink) => (await fetch(`${server.url}/s/${link.token}/api/link`)).status === 200;

it("warns the creator under a lowered member whose link is above their level, and disables it on a click", async () => {
  const { project, pageId } = await projectWithPage("Radio HAIDF");
  const link = await linkAs("thomas@example.com", pageId, "Pour Alix", "comment");
  await apiAs("ariane@example.com", "PUT", `/api/projects/${project.id}/members/${await personId("thomas@example.com")}`, { level: "read" });
  const ariane = await tabFor("ariane@example.com");
  await ariane.goto(`${server.url}/#/projects/${project.id}`);
  await ariane.getByRole("button", { name: "Partager", exact: true }).click();
  const dialog = ariane.getByRole("dialog", { name: "Partager le projet Radio HAIDF" });
  const warning = dialog.getByTestId("member-links-warning");
  await warning.waitFor();
  expect(await warning.innerText()).toContain("Thomas a créé 1 lien en Commentaire sur ce projet (« Pour Alix »). Il continue de marcher.");
  expect(await works(link)).toBe(true);
  await warning.getByRole("button", { name: "Le désactiver" }).click();
  await warning.waitFor({ state: "detached" });
  expect(await works(link)).toBe(false);
}, 90_000);

it("offers to disable the links of members who lose access when the project becomes Privé", async () => {
  const { project, pageId } = await projectWithPage("Agora");
  const link = await linkAs("thomas@example.com", pageId, "Client", "read");
  const ariane = await tabFor("ariane@example.com");
  await ariane.goto(`${server.url}/#/projects/${project.id}`);
  await ariane.getByRole("button", { name: "Partager", exact: true }).click();
  const dialog = ariane.getByRole("dialog", { name: "Partager le projet Agora" });
  await dialog.getByRole("radio", { name: "Privé" }).click();
  const confirm = ariane.getByRole("dialog", { name: "Passer « Agora » en privé ?" });
  await confirm.getByText("Leur lien de partage continue de marcher.").waitFor();
  await confirm.getByLabel("Désactiver aussi ce lien de partage").check();
  await confirm.getByRole("button", { name: "Passer en privé" }).click();
  await expect.poll(async () => ((await (await apiAs("ariane@example.com", "GET", `/api/projects/${project.id}`)).json()) as Project).visibility).toBe("private");
  await expect.poll(() => works(link)).toBe(false);
}, 90_000);

it("shows the Privé note to the creator, and hides link creation from a member added to a Privé project", async () => {
  const { project, pageId } = await projectWithPage("Secret");
  await apiAs("ariane@example.com", "PATCH", `/api/projects/${project.id}`, { visibility: "private" });
  await apiAs("ariane@example.com", "PUT", `/api/projects/${project.id}/members/${await personId("thomas@example.com")}`, { level: "write" });
  const ariane = await tabFor("ariane@example.com");
  await ariane.goto(`${server.url}/#/pages/${pageId}`);
  await ariane.getByRole("button", { name: /^Partager/ }).click();
  const mine = ariane.getByRole("dialog", { name: /Partager « Home »/ });
  await mine.getByText("Sur un projet privé, seuls toi et les admins créez des liens.").waitFor();
  await mine.getByRole("button", { name: "Créer un lien" }).waitFor();
  const thomas = await tabFor("thomas@example.com");
  await thomas.goto(`${server.url}/#/pages/${pageId}`);
  await thomas.getByRole("button", { name: /^Partager/ }).click();
  const his = thomas.getByRole("dialog", { name: /Partager « Home »/ });
  await his.getByText("Sur un projet privé, seuls son créateur et les admins créent des liens.").waitFor();
  expect(await his.getByRole("button", { name: "Créer un lien" }).count()).toBe(0);
}, 90_000);

it("asks whether to disable the links of a deactivated account, and Mon compte lists one's own links", async () => {
  const { pageId } = await projectWithPage("Mes liens");
  const link = await linkAs("thomas@example.com", pageId, "Pour Marc", "comment");
  const thomas = await tabFor("thomas@example.com");
  await thomas.goto(`${server.url}/#/account`);
  const panel = thomas.getByRole("region", { name: "Mes liens de partage" });
  await panel.getByRole("heading", { name: /Mes liens de partage · \d+ actifs?/ }).waitFor();
  const row = panel.getByTestId("my-link").filter({ hasText: "Pour Marc" });
  expect(await row.innerText()).toContain("Mes liens › Home · Commentaire · sans expiration");
  await row.getByRole("button", { name: "Ouvrir" }).click();
  await thomas.waitForURL(new RegExp(`#/pages/${pageId}`));

  const admin = await tabFor("vincent@example.com");
  await admin.goto(`${server.url}/#/accounts`);
  await admin.getByRole("button", { name: "Désactiver" }).nth(1).waitFor();
  const thomasRow = admin.getByRole("row", { name: /Thomas Lefevre/ });
  await thomasRow.getByRole("button", { name: "Désactiver" }).click();
  const dialog = admin.getByRole("alertdialog", { name: "Désactiver Thomas Lefevre ?" });
  await dialog.getByText("Son lien de partage continue de marcher.").waitFor();
  const box = dialog.getByLabel("Désactiver aussi son lien de partage");
  expect(await box.isChecked()).toBe(false);
  await box.check();
  await dialog.getByRole("button", { name: "Désactiver", exact: true }).click();
  await expect.poll(() => works(link)).toBe(false);
}, 90_000);

async function personId(email: string): Promise<string> {
  const me = (await (await apiAs(email, "GET", "/api/me")).json()) as { id: string };
  return me.id;
}
