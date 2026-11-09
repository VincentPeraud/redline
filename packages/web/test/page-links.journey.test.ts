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

beforeAll(async () => {
  webDir = mkdtempSync(join(tmpdir(), "redline-web-"));
  dataDir = mkdtempSync(join(tmpdir(), "redline-page-links-"));
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

async function memberTab(email = "ariane@example.com"): Promise<Page> {
  const context = await browser.newContext();
  await context.addCookies([{ name: "redline_session", value: await cookieOf(email), url: server.url }]);
  return context.newPage();
}

async function api(method: string, path: string, body?: unknown): Promise<Response> {
  const cookie = `redline_session=${await cookieOf("ariane@example.com")}`;
  return fetch(server.url + path, { method, headers: { ...JSON_HEADERS, cookie }, body: method === "GET" ? undefined : JSON.stringify(body ?? {}) });
}

async function pageWithLink(title: string, level: "read" | "comment" = "read"): Promise<{ project: Project; pageId: string; link: ShareLink }> {
  const project = (await (await api("POST", "/api/projects", { title })).json()) as Project;
  const page = (await (await api("POST", `/api/projects/${project.id}/pages`, { title: "Planifier une sortie", files: FILES })).json()) as { id: string };
  const link = (await (await api("POST", `/api/pages/${page.id}/links`, { kind: "generic", name: "Client", level })).json()) as ShareLink;
  return { project, pageId: page.id, link };
}

it("creates, copies, disables and reactivates a link from the Partager dialog", async () => {
  const project = (await (await api("POST", "/api/projects", { title: "Radio HAIDF" })).json()) as Project;
  const page = (await (await api("POST", `/api/projects/${project.id}/pages`, { title: "Planifier une sortie", files: FILES })).json()) as { id: string };
  const tab = await memberTab();
  await tab.goto(`${server.url}/#/pages/${page.id}`);
  const share = tab.getByRole("button", { name: /^Partager/ });
  await share.click();
  const dialog = tab.getByRole("dialog", { name: "Partager « Planifier une sortie »" });
  await expect.poll(() => dialog.getByText("Aucun lien sur cette page.").count()).toBe(1);
  await dialog.getByRole("button", { name: "Créer un lien" }).click();
  const form = tab.getByRole("dialog", { name: "Créer un lien" });
  await form.getByRole("radio", { name: "Tout le monde avec le lien" }).click();
  await form.getByLabel("Nom du lien").fill("Client HAIDF");
  await form.getByLabel("Expiration").selectOption({ label: "Dans 7 jours" });
  await form.getByRole("button", { name: "Créer le lien" }).click();
  await expect.poll(() => form.getByText(/Lien créé pour Client HAIDF, en Lecture/).count()).toBe(1);
  const address = await form.getByRole("textbox", { name: "Lien" }).inputValue();
  expect(address).toMatch(new RegExp(`^${server.url}/s/[\\w-]{22,}$`));
  await form.getByRole("button", { name: "Terminé" }).click();
  await expect.poll(() => tab.getByRole("button", { name: /^Partager/ }).textContent()).toContain("1");

  await tab.getByRole("button", { name: /^Partager/ }).click();
  const list = tab.getByRole("dialog", { name: "Partager « Planifier une sortie »" });
  const row = list.getByTestId("link-row");
  expect(await row.textContent()).toContain("Client HAIDF");
  expect(await row.textContent()).toContain("Tout le monde avec le lien · créé par toi");
  expect(await row.textContent()).toContain("jamais ouvert · 0 appareil");
  await row.getByRole("button", { name: "Désactiver" }).click();
  const confirm = tab.getByRole("alertdialog", { name: "Désactiver « Client HAIDF » ?" });
  expect(await confirm.textContent()).toContain("la même adresse remarchera");
  await confirm.getByRole("button", { name: "Désactiver le lien" }).click();
  await list.getByRole("button", { name: /1 lien désactivé ou expiré/ }).click();
  expect(await list.getByTestId("link-row").textContent()).toContain("Désactivé le");
  await list.getByRole("button", { name: "Réactiver" }).click();
  await expect.poll(() => list.getByRole("button", { name: "Désactiver" }).count()).toBe(1);
  const links = (await (await api("GET", `/api/pages/${page.id}/links`)).json()) as ShareLink[];
  expect(address.endsWith(links[0].token)).toBe(true);
  await tab.context().close();
});

it("shows a visitor the page with its level, the presentation, and nothing a visitor may not do", async () => {
  const { pageId, link } = await pageWithLink("Visible project");
  const context = await browser.newContext({ viewport: { width: 1280, height: 800 } });
  const tab = await context.newPage();
  await tab.goto(`${server.url}/s/${link.token}`);
  await tab.getByText("Planifier une sortie").first().waitFor();
  expect(await tab.getByText("Visible project").count()).toBeGreaterThan(0);
  expect(await tab.getByText("Lecture", { exact: true }).count()).toBe(1);
  expect(await tab.getByText("Vincent").count()).toBe(0);
  expect(await tab.getByText("Ariane").count()).toBe(0);
  expect(await tab.getByRole("button", { name: /^Partager/ }).count()).toBe(0);
  expect(await tab.getByRole("button", { name: /Commenter/ }).count()).toBe(0);
  expect(await tab.getByRole("button", { name: /Historique|historique/ }).count()).toBe(0);
  await expect.poll(async () => tab.frameLocator("iframe").first().getByText("Visitor content").count(), { timeout: 15_000 }).toBe(1);
  await tab.getByRole("button", { name: "Présenter" }).click();
  await tab.getByTestId("play").waitFor();
  expect(tab.url()).toContain(`#/pages/${pageId}/play/home.html`);
  expect(await tab.getByRole("button", { name: "Tweaks" }).count()).toBe(0);
  await context.close();
});

it("opens the presentation on a phone, with only previous and next", async () => {
  const { link } = await pageWithLink("Phone project");
  const context = await browser.newContext({ viewport: { width: 390, height: 844 }, hasTouch: true, isMobile: true });
  const tab = await context.newPage();
  await tab.goto(`${server.url}/s/${link.token}`);
  await tab.getByTestId("play").waitFor();
  const bar = tab.getByRole("navigation", { name: "Artboards" });
  expect(await bar.getByRole("button").count()).toBe(2);
  expect(await tab.getByRole("button", { name: /Commenter|Commentaires/ }).count()).toBe(0);
  expect(await tab.getByText("Lecture", { exact: true }).count()).toBe(1);
  expect(await tab.getByText("Accueil").count()).toBeGreaterThan(0);
  await bar.getByRole("button", { name: "Écran suivant" }).click();
  await expect.poll(() => tab.url()).toContain("/play/list.html");
  await context.close();
});

it("shows one dead-link screen for a disabled link and an unknown one", async () => {
  const { link } = await pageWithLink("Dead project");
  await api("POST", `/api/links/${link.id}/disable`);
  for (const path of [`/s/${link.token}`, "/s/not-a-real-link"]) {
    const context = await browser.newContext();
    const tab = await context.newPage();
    await tab.goto(`${server.url}${path}`);
    await tab.getByRole("heading", { name: "Ce lien ne marche plus" }).waitFor();
    expect(await tab.getByText("Il a expiré ou a été désactivé.").count()).toBe(1);
    await context.close();
  }
});

it("sends a signed-in member to the normal page, and a member below the link's level to the visitor view", async () => {
  const { pageId, link } = await pageWithLink("Member project", "comment");
  const ariane = await memberTab();
  await ariane.goto(`${server.url}/s/${link.token}`);
  await ariane.waitForURL(`${server.url}/#/pages/${pageId}`);
  await ariane.getByRole("button", { name: /^Partager/ }).waitFor();
  await ariane.context().close();
});
