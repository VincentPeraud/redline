import Database from "better-sqlite3";
import { randomUUID } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { build } from "vite";
import type { Browser, Page } from "playwright";
import { afterAll, beforeAll, expect, it } from "vitest";
import { MANIFEST_PATH, type Project, type ShareLink, type Thread } from "@redline/shared";
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

beforeAll(async () => {
  webDir = mkdtempSync(join(tmpdir(), "redline-web-"));
  dataDir = mkdtempSync(join(tmpdir(), "redline-project-links-"));
  await build({ root: webRoot, logLevel: "silent", build: { outDir: webDir, emptyOutDir: true } });
  server = await startServer({ dataDir, port: 0, artboardPort: 0, host: "127.0.0.1", webDir, authMode: "local", log: (line) => (setupLink = line.slice(line.indexOf("http"))) });
  const token = setupLink.split("/#/setup/")[1].trim();
  await fetch(`${server.url}/api/setup`, { method: "POST", headers: JSON_HEADERS, body: JSON.stringify({ token, name: "Vincent Peraud", email: "vincent@example.com", password: PASSWORD }) });
  const db = new Database(join(dataDir, "redline.db"));
  db.prepare("INSERT INTO people (id, name, email, created_at, role, status, password_hash, origin) VALUES (?, ?, ?, ?, 'member', 'active', ?, 'local')").run(randomUUID(), "Ariane Martin", "ariane@example.com", new Date().toISOString(), await hashPassword(PASSWORD));
  db.close();
  browser = await launchBrowser();
}, 60_000);

afterAll(async () => {
  await browser?.close();
  await server?.close();
  rmSync(webDir, { recursive: true, force: true });
  rmSync(dataDir, { recursive: true, force: true });
});

const FILES = {
  "home.html": "<!doctype html><body><h1>Visitor content</h1></body>",
  [MANIFEST_PATH]: JSON.stringify({ artboards: [{ file: "home.html", title: "Accueil", x: 0, y: 0, width: 400, height: 300 }] }),
};

async function cookieOf(email: string): Promise<string> {
  const res = await fetch(`${server.url}/api/session`, { method: "POST", headers: JSON_HEADERS, body: JSON.stringify({ email, password: PASSWORD }) });
  return (res.headers.get("set-cookie") ?? "").split(";")[0].split("=")[1];
}

async function api(method: string, path: string, body?: unknown): Promise<Response> {
  const cookie = `redline_session=${await cookieOf("ariane@example.com")}`;
  return fetch(server.url + path, { method, headers: { ...JSON_HEADERS, cookie }, body: method === "GET" ? undefined : JSON.stringify(body ?? {}) });
}

const newPage = async (projectId: string, title: string) => ((await (await api("POST", `/api/projects/${projectId}/pages`, { title, files: FILES })).json()) as { id: string }).id;
const newLink = async (path: string, body: object) => (await (await api("POST", path, body)).json()) as ShareLink;

it("opens a project link on the list of its pages: later pages in, archived ones out, no Nouvelle page in Commentaire", async () => {
  const project = (await (await api("POST", "/api/projects", { title: "Agora" })).json()) as Project;
  await newPage(project.id, "Réunion avant");
  const link = await newLink(`/api/projects/${project.id}/links`, { kind: "generic", name: "Client", level: "comment" });
  const context = await browser.newContext({ viewport: { width: 1280, height: 800 } });
  const tab = await context.newPage();
  await tab.goto(`${server.url}/s/${link.token}`);
  await tab.getByRole("heading", { name: "Agora" }).waitFor();
  await tab.getByText("1 page · les nouvelles pages apparaîtront ici").waitFor();
  expect(await tab.getByRole("button", { name: "Nouvelle page" }).count()).toBe(0);
  await tab.screenshot({ path: join(tmpdir(), "visitor-project-desktop.png") });

  // A page created after the link shows up live; an archived one leaves.
  const later = await newPage(project.id, "Inscription");
  const gone = await newPage(project.id, "Brouillon");
  await tab.getByText("Inscription").waitFor();
  await tab.getByText("Brouillon").waitFor();
  await api("POST", `/api/pages/${gone}/archive`);
  await tab.getByText("Brouillon").waitFor({ state: "detached" });
  expect(await tab.getByText("2 pages").count()).toBe(1);

  await tab.getByRole("link", { name: /Inscription/ }).click();
  await tab.getByRole("radio", { name: "Commenter (C)" }).waitFor();
  expect(tab.url()).toContain(later);
  await tab.getByRole("link", { name: "Agora" }).click();
  await tab.getByRole("heading", { name: "Agora" }).waitFor();

  const phone = await browser.newContext({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true });
  const small = await phone.newPage();
  await small.goto(`${server.url}/s/${link.token}`);
  await small.getByRole("heading", { name: "Agora" }).waitFor();
  await small.screenshot({ path: join(tmpdir(), "visitor-project-phone.png") });
  await phone.close();
  await context.close();
}, 30_000);

it("lets an Écriture personal link work on a project: Nouvelle page, team threads, a comment that waits without an agent, history signed with the link", async () => {
  const project = (await (await api("POST", "/api/projects", { title: "Agora" })).json()) as Project;
  const pageId = await newPage(project.id, "Réunion avant");
  await api("POST", `/api/pages/${pageId}/threads`, { target: { kind: "artboard", artboard: "home.html" }, body: "Team remark", held: true });
  const link = await newLink(`/api/projects/${project.id}/links`, { kind: "personal", name: "Alix", level: "write" });
  const context = await browser.newContext({ viewport: { width: 1280, height: 800 } });
  const tab = await context.newPage();
  await tab.goto(`${server.url}/s/${link.token}`);
  await tab.getByText("Écriture · Alix").first().waitFor();

  await tab.getByRole("button", { name: "Nouvelle page" }).click();
  const dialog = tab.getByRole("dialog", { name: "Nouvelle page" });
  expect(await dialog.getByLabel(/Instructions pour Claude/).count()).toBe(0);
  await dialog.getByLabel("Nom de la page").fill("Inscription");
  await dialog.getByRole("button", { name: "Créer la page" }).click();
  await tab.getByRole("radio", { name: "Commenter (C)" }).waitFor();
  const pages = (await (await api("GET", `/api/projects/${project.id}/pages`)).json()) as { id: string; title: string }[];
  const created = pages.find((p) => p.title === "Inscription")!;
  const createdVersions = (await (await api("GET", `/api/pages/${created.id}/versions`)).json()) as { linkAuthor?: { name: string } }[];
  expect(createdVersions[0].linkAuthor?.name).toBe("Alix");

  await tab.goto(`${server.url}/s/${link.token}#/pages/${pageId}`);
  await tab.getByRole("heading", { name: "Commentaires · 1" }).waitFor();
  await tab.getByText("Team remark").waitFor();
  await tab.getByRole("radio", { name: "Commenter (C)" }).click();
  await tab.getByRole("button", { name: "Commenter tout home.html" }).click();
  const composer = tab.getByRole("form", { name: "Nouveau commentaire" });
  expect(await composer.getByLabel("Ton nom").count()).toBe(0);
  await composer.getByLabel(/^Commentaire sur/).fill("Agrandis le titre.");
  await composer.getByRole("button", { name: "Envoyer" }).click();
  await tab.getByRole("heading", { name: "Commentaires · 2" }).waitFor();
  await tab.getByText("Alix (lien)").first().waitFor();
  await tab.getByText(/Claude n'est pas disponible pour l'instant/).waitFor();
  await tab.screenshot({ path: join(tmpdir(), "visitor-write-desktop.png") });
  const mine = ((await (await api("GET", `/api/pages/${pageId}/threads`)).json()) as Thread[]).find((t) => t.body === "Agrandis le titre.")!;
  expect(mine).toMatchObject({ status: "open", linkAuthor: { name: "Alix" } });
  await context.close();
});

it("shows members the name of the link behind a comment waiting to be read", async () => {
  const project = (await (await api("POST", "/api/projects", { title: "Relire" })).json()) as Project;
  const pageId = await newPage(project.id, "Page");
  const link = await newLink(`/api/pages/${pageId}/links`, { kind: "generic", name: "Client HAIDF", level: "comment" });
  await fetch(`${server.url}/s/${link.token}/api/pages/${pageId}/threads`, { method: "POST", headers: JSON_HEADERS, body: JSON.stringify({ target: { kind: "artboard", artboard: "home.html" }, body: "Joli", visitorName: "Marc" }) });
  const context = await browser.newContext({ viewport: { width: 1280, height: 800 } });
  await context.addCookies([{ name: "redline_session", value: await cookieOf("ariane@example.com"), url: server.url }]);
  const member = await context.newPage();
  await member.goto(`${server.url}/#/pages/${pageId}`);
  await member.getByRole("tab", { name: /^Commentaires/ }).click();
  await member.getByText("lien « Client HAIDF »").waitFor();
  await context.close();
});

it("offers Écriture for a link made for one person only", async () => {
  const project = (await (await api("POST", "/api/projects", { title: "Écriture offer" })).json()) as Project;
  const pageId = await newPage(project.id, "Page");
  const context = await browser.newContext({ viewport: { width: 1280, height: 800 } });
  await context.addCookies([{ name: "redline_session", value: await cookieOf("ariane@example.com"), url: server.url }]);
  const tab = await context.newPage();
  await tab.goto(`${server.url}/#/pages/${pageId}`);
  await tab.getByRole("button", { name: /^Partager/ }).click();
  await tab.getByRole("dialog", { name: /^Partager/ }).getByRole("button", { name: "Créer un lien" }).click();
  const form = tab.getByRole("dialog", { name: "Créer un lien" });
  const write = form.getByRole("radio", { name: /^Écriture/ });
  expect(await write.isDisabled()).toBe(false);
  await write.check();
  await form.getByLabel("Son nom").fill("Alix");
  await form.getByRole("radio", { name: "Tout le monde avec le lien" }).click();
  expect(await write.isDisabled()).toBe(true);
  expect(await write.isChecked()).toBe(false);
  await form.getByText("Réservé aux liens pour une personne.").waitFor();
  await form.getByRole("radio", { name: "Une personne", exact: true }).click();
  await write.check();
  await form.getByRole("button", { name: "Créer le lien" }).click();
  await form.getByText(/Lien créé pour Alix, en Écriture/).waitFor();
  await context.close();
});
