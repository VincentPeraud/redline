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
  dataDir = mkdtempSync(join(tmpdir(), "redline-comment-links-"));
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
  "list.html": "<!doctype html><body><h1>Second screen</h1></body>",
  [MANIFEST_PATH]: JSON.stringify({ artboards: [{ file: "home.html", title: "Accueil", x: 0, y: 0, width: 400, height: 300 }, { file: "list.html", title: "Liste", x: 500, y: 0, width: 400, height: 300 }] }),
};

async function cookieOf(email: string): Promise<string> {
  const res = await fetch(`${server.url}/api/session`, { method: "POST", headers: JSON_HEADERS, body: JSON.stringify({ email, password: PASSWORD }) });
  return (res.headers.get("set-cookie") ?? "").split(";")[0].split("=")[1];
}

async function api(method: string, path: string, body?: unknown): Promise<Response> {
  const cookie = `redline_session=${await cookieOf("ariane@example.com")}`;
  return fetch(server.url + path, { method, headers: { ...JSON_HEADERS, cookie }, body: method === "GET" ? undefined : JSON.stringify(body ?? {}) });
}

async function pageWithLink(title: string, link: object = {}): Promise<{ pageId: string; link: ShareLink }> {
  const project = (await (await api("POST", "/api/projects", { title })).json()) as Project;
  const page = (await (await api("POST", `/api/projects/${project.id}/pages`, { title: "Planifier une sortie", files: FILES })).json()) as { id: string };
  const created = (await (await api("POST", `/api/pages/${page.id}/links`, { kind: "generic", name: "Client", level: "comment", ...link })).json()) as ShareLink;
  return { pageId: page.id, link: created };
}

const threadsOf = async (pageId: string) => (await (await api("GET", `/api/pages/${pageId}/threads`)).json()) as Thread[];

it("lets a visitor comment on an artboard: asks the name once, shows the link's comments, and the team reads it as Marc (lien)", async () => {
  const { pageId, link } = await pageWithLink("Visitor comments");
  const context = await browser.newContext({ viewport: { width: 1280, height: 800 } });
  const tab = await context.newPage();
  await tab.goto(`${server.url}/s/${link.token}`);
  await tab.getByText("Commentaire", { exact: true }).first().waitFor();
  await tab.getByRole("heading", { name: "Commentaires de ce lien · 0" }).waitFor();
  await tab.getByRole("radio", { name: "Commenter (C)" }).click();
  await tab.getByRole("button", { name: "Commenter tout home.html" }).click();
  const composer = tab.getByRole("form", { name: "Nouveau commentaire" });
  await composer.getByRole("heading", { name: "Avant ton premier commentaire" }).waitFor();
  await composer.getByLabel("Ton nom").fill("Marc");
  await composer.getByLabel(/^Commentaire sur/).fill("Le titre est trop petit.");
  await tab.screenshot({ path: join(tmpdir(), "visitor-composer-desktop.png") });
  await composer.getByRole("button", { name: "Envoyer" }).click();
  await tab.getByRole("heading", { name: "Commentaires de ce lien · 1" }).waitFor();
  expect(await tab.getByTestId("visitor-thread").textContent()).toContain("Toi (Marc)");
  await tab.screenshot({ path: join(tmpdir(), "visitor-panel-desktop.png") });

  const [thread] = await threadsOf(pageId);
  expect(thread).toMatchObject({ status: "review", body: "Le titre est trop petit.", linkAuthor: { linkId: link.id, name: "Marc" } });

  // The name is remembered on the device: no question the second time.
  await tab.getByRole("button", { name: "Commenter tout list.html" }).click();
  await composer.getByText("Tu commentes en tant que").waitFor();
  expect(await composer.textContent()).toContain("Marc");
  expect(await composer.getByLabel("Ton nom").count()).toBe(0);
  await composer.getByRole("button", { name: "changer" }).click();
  await composer.getByLabel("Ton nom").waitFor();
  await composer.getByRole("button", { name: "Annuler" }).click();
  await context.close();

  // A member sees it as a comment from a link, waiting to be read.
  const cookie = await cookieOf("ariane@example.com");
  const memberContext = await browser.newContext({ viewport: { width: 1280, height: 800 } });
  await memberContext.addCookies([{ name: "redline_session", value: cookie, url: server.url }]);
  const member = await memberContext.newPage();
  await member.goto(`${server.url}/#/pages/${pageId}`);
  await member.getByRole("tab", { name: /^Commentaires/ }).click();
  await member.getByText("Marc (lien)").first().waitFor();
  await member.getByTestId("review-bar").waitFor();
  await memberContext.close();
});

it("never shows a visitor the team's comments, and a personal link signs without asking a name", async () => {
  const { pageId, link } = await pageWithLink("Personal link", { kind: "personal", name: "Alix" });
  await api("POST", `/api/pages/${pageId}/threads`, { target: { kind: "artboard", artboard: "list.html" }, body: "Team only" });
  const context = await browser.newContext({ viewport: { width: 1280, height: 800 } });
  const tab = await context.newPage();
  await tab.goto(`${server.url}/s/${link.token}`);
  await tab.getByRole("heading", { name: "Commentaires de ce lien · 0" }).waitFor();
  expect(await tab.getByText("Team only").count()).toBe(0);
  await tab.getByRole("radio", { name: "Commenter (C)" }).click();
  await tab.getByRole("button", { name: "Commenter tout home.html" }).click();
  const composer = tab.getByRole("form", { name: "Nouveau commentaire" });
  expect(await composer.getByLabel("Ton nom").count()).toBe(0);
  expect(await composer.textContent()).toContain("Tu commentes en tant que Alix");
  await composer.getByLabel(/^Commentaire sur/).fill("From Alix");
  await composer.getByRole("button", { name: "Envoyer" }).click();
  await tab.getByTestId("visitor-thread").getByText("Toi (Alix)").waitFor();
  await context.close();
});

it("lets a visitor on a phone comment an element and read the link's comments", async () => {
  const { pageId, link } = await pageWithLink("Phone comments");
  const other = await fetch(`${server.url}/s/${link.token}/api/pages/${pageId}/threads`, { method: "POST", headers: JSON_HEADERS, body: JSON.stringify({ target: { kind: "artboard", artboard: "list.html" }, body: "Weather please", visitorName: "Sophie" }) });
  expect(other.status).toBe(201);
  const context = await browser.newContext({ viewport: { width: 390, height: 844 }, hasTouch: true, isMobile: true });
  const tab = await context.newPage();
  await tab.goto(`${server.url}/s/${link.token}`);
  await tab.getByTestId("play").waitFor();
  const bar = tab.getByRole("navigation", { name: "Artboards" });
  await bar.getByRole("button", { name: "Commentaires · 1" }).waitFor();
  await bar.getByRole("button", { name: "Commenter", exact: true }).click();
  await tab.getByText("Touche l'élément à commenter.").waitFor();
  await tab.screenshot({ path: join(tmpdir(), "visitor-bar-phone.png") });
  await expect.poll(async () => tab.frameLocator("iframe").first().getByText("Visitor content").count(), { timeout: 15_000 }).toBe(1);
  await tab.frameLocator("iframe").first().locator("h1").click();
  const composer = tab.getByRole("form", { name: "Nouveau commentaire" });
  await composer.getByLabel("Ton nom").fill("Marc");
  await composer.getByLabel(/^Commentaire sur/).fill("Trop petit sur téléphone.");
  await tab.screenshot({ path: join(tmpdir(), "visitor-composer-phone.png") });
  await composer.getByRole("button", { name: "Envoyer" }).click();
  await bar.getByRole("button", { name: "Commentaires · 2" }).waitFor();
  await bar.getByRole("button", { name: "Commentaires · 2" }).click();
  const list = tab.getByRole("region", { name: "Commentaires de ce lien" });
  expect(await list.getByTestId("visitor-thread").count()).toBe(2);
  expect(await list.textContent()).toContain("Toi (Marc)");
  expect(await list.textContent()).toContain("Sophie");
  await tab.screenshot({ path: join(tmpdir(), "visitor-list-phone.png") });
  const mine = (await threadsOf(pageId)).find((t) => t.body === "Trop petit sur téléphone.");
  expect(mine).toMatchObject({ status: "review", artboard: "home.html", selector: "body > h1", linkAuthor: { name: "Marc" } });
  await context.close();
});

it("creates a Commentaire link with the checkbox that sends its comments straight to Claude", async () => {
  const project = (await (await api("POST", "/api/projects", { title: "Direct link" })).json()) as Project;
  const page = (await (await api("POST", `/api/projects/${project.id}/pages`, { title: "Planifier une sortie", files: FILES })).json()) as { id: string };
  const context = await browser.newContext({ viewport: { width: 1280, height: 800 } });
  await context.addCookies([{ name: "redline_session", value: await cookieOf("ariane@example.com"), url: server.url }]);
  const tab = await context.newPage();
  await tab.goto(`${server.url}/#/pages/${page.id}`);
  await tab.getByRole("button", { name: /^Partager/ }).click();
  await tab.getByRole("dialog", { name: "Partager « Planifier une sortie »" }).getByRole("button", { name: "Créer un lien" }).click();
  const form = tab.getByRole("dialog", { name: "Créer un lien" });
  await form.getByRole("radio", { name: "Tout le monde avec le lien" }).click();
  await form.getByLabel("Nom du lien").fill("Client HAIDF");
  await form.getByRole("radio", { name: "Commentaire" }).click();
  const direct = form.getByRole("checkbox", { name: "Les commentaires de ce lien partent directement à Claude, sans relecture" });
  expect(await direct.isChecked()).toBe(false);
  await tab.screenshot({ path: join(tmpdir(), "create-link-comment.png") });
  await direct.check();
  await form.getByRole("button", { name: "Créer le lien" }).click();
  await form.getByText(/Lien créé pour Client HAIDF, en Commentaire/).waitFor();
  const [created] = (await (await api("GET", `/api/pages/${page.id}/links`)).json()) as ShareLink[];
  expect(created).toMatchObject({ level: "comment", direct: true });
  await context.close();
});
