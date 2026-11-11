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
  dataDir = mkdtempSync(join(tmpdir(), "redline-levels-"));
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

it("lowers a member from the Partager dialog, restricts the project page and the canvas for them, and lifts it", async () => {
  const { project, pageId } = await projectWithPage("Agora");
  const ariane = await tabFor("ariane@example.com");
  await ariane.goto(`${server.url}/#/projects/${project.id}`);
  await ariane.getByRole("button", { name: "Partager", exact: true }).click();
  const dialog = ariane.getByRole("dialog", { name: "Partager le projet Agora" });
  await dialog.getByRole("button", { name: "Changer le niveau d'un membre" }).click();
  await dialog.getByLabel("Membre à ajouter").selectOption({ label: "Thomas Lefevre" });
  await dialog.getByLabel("Niveau", { exact: true }).selectOption({ label: "Lecture" });
  await dialog.getByRole("button", { name: "Ajouter" }).click();
  const row = dialog.getByTestId("member-row");
  await row.waitFor();
  expect(await row.innerText()).toContain("Thomas Lefevre");
  expect(await row.getByLabel("Niveau Thomas").inputValue()).toBe("read");

  const thomas = await tabFor("thomas@example.com");
  await thomas.goto(`${server.url}/#/projects/${project.id}`);
  await thomas.getByRole("heading", { name: "Agora" }).waitFor();
  await thomas.getByTestId("page-card").waitFor();
  expect(await thomas.getByRole("button", { name: "Nouvelle page" }).count()).toBe(0);
  expect(await thomas.getByRole("button", { name: "Renommer la page" }).count()).toBe(0);
  expect(await thomas.getByRole("button", { name: "Partager", exact: true }).count()).toBe(0);
  expect(await thomas.getByRole("button", { name: /Archiver/ }).count()).toBe(0);
  await thomas.goto(`${server.url}/#/pages/${pageId}`);
  await thomas.getByRole("tab", { name: /Commentaires/ }).click();
  await thomas.getByText("Niveau Lecture : les fils se lisent").waitFor();
  expect(await thomas.getByRole("button", { name: "Commenter (C)" }).count()).toBe(0);

  await row.getByLabel("Niveau Thomas").selectOption({ label: "Commentaire" });
  await expect.poll(async () => (await (await apiAs("thomas@example.com", "GET", `/api/projects/${project.id}`)).json() as Project).viewerLevel).toBe("comment");
  await thomas.reload();
  await thomas.getByRole("button", { name: "Commenter (C)" }).waitFor();
  expect(await thomas.getByRole("button", { name: "Tout envoyer à Claude" }).count()).toBe(0);

  await row.getByRole("button", { name: "Retirer" }).click();
  await expect.poll(() => dialog.getByTestId("member-row").count()).toBe(0);
  await thomas.reload();
  await thomas.getByRole("button", { name: "Commenter (C)" }).waitFor();
  expect(await thomas.getByRole("tab", { name: "Conversation" }).count()).toBe(1);
}, 90_000);

it("adds a chosen member with a level to a Privé project", async () => {
  const { project } = await projectWithPage("Maquettes perso");
  await apiAs("ariane@example.com", "PATCH", `/api/projects/${project.id}`, { visibility: "private" });
  const ariane = await tabFor("ariane@example.com");
  await ariane.goto(`${server.url}/#/projects/${project.id}`);
  await ariane.getByRole("button", { name: "Partager", exact: true }).click();
  const dialog = ariane.getByRole("dialog", { name: "Partager le projet Maquettes perso" });
  await dialog.getByText("créateur du projet").waitFor();
  await dialog.getByLabel("Membre à ajouter").selectOption({ label: "Thomas Lefevre" });
  await dialog.getByLabel("Niveau", { exact: true }).selectOption({ label: "Commentaire" });
  await dialog.getByRole("button", { name: "Ajouter" }).click();
  await dialog.getByTestId("member-row").waitFor();
  const thomas = await tabFor("thomas@example.com");
  await thomas.goto(`${server.url}/#/projects/${project.id}`);
  await thomas.getByRole("heading", { name: "Maquettes perso" }).waitFor();
  expect(await thomas.getByRole("button", { name: "Nouvelle page" }).count()).toBe(0);
}, 90_000);

it("shows the Partager dialog read-only to a member in Écriture who is not the creator", async () => {
  const { project } = await projectWithPage("Radio HAIDF");
  const thomas = await tabFor("thomas@example.com");
  await thomas.goto(`${server.url}/#/projects/${project.id}`);
  await thomas.getByRole("button", { name: "Partager", exact: true }).click();
  const dialog = thomas.getByRole("dialog", { name: "Partager le projet Radio HAIDF" });
  await dialog.getByText("Seuls Ariane Martin (créateur) et les admins changent la visibilité et les niveaux.").waitFor();
  expect(await dialog.getByRole("radio", { name: "Privé" }).isDisabled()).toBe(true);
  expect(await dialog.getByRole("button", { name: "Changer le niveau d'un membre" }).count()).toBe(0);
}, 60_000);

it("counts the projects and the Privé ones under the title of the project list", async () => {
  const before = await (await apiAs("ariane@example.com", "GET", "/api/projects")).json() as Project[];
  const { project } = await projectWithPage("Secret");
  await apiAs("ariane@example.com", "PATCH", `/api/projects/${project.id}`, { visibility: "private" });
  const ariane = await tabFor("ariane@example.com");
  await ariane.goto(`${server.url}/#/projects`);
  const privateCount = before.filter((p) => p.visibility === "private").length + 1;
  await expect.poll(() => ariane.getByTestId("projects-summary").innerText()).toBe(`${before.length + 1} projets · ${privateCount} ${privateCount > 1 ? "privés" : "privé"}`);
}, 60_000);
