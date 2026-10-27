import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { build } from "vite";
import { chromium, type Browser, type Page } from "playwright";
import { afterAll, beforeAll, expect, it } from "vitest";
import { DESIGN_MD_PATH, MANIFEST_PATH } from "@redline/shared";
import { startServer, type RunningServer } from "../../server/src/start.js";
import { Store } from "../../server/src/store.js";
import { startTestServer, type TestServer } from "@redline/server/test-harness";

const webRoot = fileURLToPath(new URL("..", import.meta.url));
const HUMAN = "h".repeat(32);
const person = (user: string, name: string) => ({ "x-redline-proxy-secret": HUMAN, "remote-user": user, "remote-name": name, "remote-email": `${user}@example.com` });
const ariane = person("amartin", "Ariane Martin");
const vincent = person("vperaud", "Vincent Peraud");
const beforeSso = { "x-redline-proxy-secret": HUMAN };

const manifestOf = (...files: string[]) =>
  JSON.stringify({ artboards: files.map((file, i) => ({ file, x: i * 400, y: 0, width: 300, height: 200 })), tweaks: [{ id: "accent", type: "color", label: "Accent", default: "#e5484d" }] });
const filesOf = (title: string, ...artboards: string[]) => ({ [MANIFEST_PATH]: manifestOf(...artboards), ...Object.fromEntries(artboards.map((file) => [file, `<h1>${title} ${file}</h1>`])) });

let webDir: string;
let dataDir: string;
let browser: Browser;
let sso: RunningServer;
let plain: TestServer;
let projectId: string;
let historyPageId: string;
let deletionPageId: string;
let plainProjectId: string;
let plainPageId: string;

const call = (base: string, headers: Record<string, string>) => async <T>(method: string, path: string, body?: unknown): Promise<T> => {
  const res = await fetch(base + path, { method, headers: { "content-type": "application/json", ...headers }, body: body === undefined ? undefined : JSON.stringify(body) });
  expect(res.status).toBeLessThan(300);
  return res.json() as Promise<T>;
};

beforeAll(async () => {
  webDir = mkdtempSync(join(tmpdir(), "redline-web-"));
  dataDir = mkdtempSync(join(tmpdir(), "redline-signed-history-"));
  await build({ root: webRoot, logLevel: "silent", build: { outDir: webDir, emptyOutDir: true } });
  sso = await startServer({
    dataDir,
    port: 0,
    artboardPort: 0,
    host: "127.0.0.1",
    webDir,
    proxySecrets: { human: HUMAN, machine: "m".repeat(32) },
    identity: { userHeader: "remote-user", nameHeader: "remote-name", emailHeader: "remote-email" },
  });
  plain = await startTestServer({ webDir });
  browser = await chromium.launch();

  // Both people are known to the server before anything is signed.
  await call(sso.url, ariane)("GET", "/api/me");
  await call(sso.url, vincent)("GET", "/api/me");

  // A project whose pages were made by different hands.
  const project = await call(sso.url, vincent)<{ id: string }>("POST", "/api/projects", { title: "Acme" });
  projectId = project.id;
  const page = (title: string, headers: Record<string, string>, files = filesOf(title, "home.html")) =>
    call(sso.url, headers)<{ id: string; version: { id: string } }>("POST", `/api/projects/${projectId}/pages`, { title, files });

  // The history of home.html on "Parcours": created before the SSO, then Terminal, Claude for Ariane, Vincent by hand, Ariane's restoration.
  const history = await page("Parcours", beforeSso);
  historyPageId = history.id;
  const store = new Store(dataDir);
  const ariaStored = store.getPerson("amartin")!;
  const first = store.listVersions(history.id)[0];
  store.addVersion(history.id, { ...filesOf("Terminal", "home.html") }, "Ajuste les marges de l'artboard", "terminal");
  store.addVersion(history.id, { ...filesOf("Claude", "home.html") }, "Bouton principal plein", "thread", { originId: "t1", originLabel: "Bouton trop discret", person: ariaStored });
  store.close();
  await call(sso.url, vincent)("POST", `/api/pages/${history.id}/versions`, { files: filesOf("Manual", "home.html"), message: "Retouche à la main", origin: "user" });
  await call(sso.url, ariane)("POST", `/api/pages/${history.id}/versions/${first.id}/restore`, {});

  // Pages for the page menu and the deleted artboards.
  await page("Profil médecin", ariane);
  await page("Hier", beforeSso);
  const deletions = await page("Onboarding", vincent, filesOf("Onboarding", "ecran-1.html", "ecran-4.html", "ecran-5.html", "ecran-6.html"));
  deletionPageId = deletions.id;
  const writer = new Store(dataDir);
  writer.createPage(projectId, "Erreurs", filesOf("Erreurs", "home.html"), "claude", writer.getPerson("amartin"));
  writer.createPage(projectId, "Page de Claude seule", filesOf("Seule", "home.html"), "claude");
  writer.addVersion(deletions.id, filesOf("Onboarding", "ecran-1.html", "ecran-5.html", "ecran-6.html"), "Trop d'étapes", "thread", { originId: "t2", originLabel: "Trop d'étapes", person: writer.getPerson("vperaud") });
  writer.close();
  await call(sso.url, ariane)("POST", `/api/pages/${deletions.id}/versions`, { files: filesOf("Onboarding", "ecran-1.html", "ecran-6.html"), message: "Retire l'écran 5", origin: "user" });
  await call(sso.url, beforeSso)("POST", `/api/pages/${deletions.id}/versions`, { files: filesOf("Onboarding", "ecran-1.html"), message: "Retire l'écran 6", origin: "user" });

  // DESIGN.md: a rule from before the SSO, one from Ariane, one from Claude for Ariane, one by Vincent.
  const designMd = (headers: Record<string, string>, content: string) => call(sso.url, headers)("PUT", `/api/projects/${projectId}/design-md`, { content });
  await designMd(beforeSso, "- Police Inter, titres en 600.");
  await designMd(ariane, "- Police Inter, titres en 600.\n- Ton chaleureux, tutoiement interdit.");
  const claude = new Store(dataDir);
  claude.saveDesignMd(projectId, DESIGN_MD_PATH, Buffer.from("- Police Inter, titres en 600.\n- Ton chaleureux, tutoiement interdit.\n- Les boutons principaux sont pleins.", "utf8"), {
    origin: "thread",
    originId: "t1",
    originLabel: "Bouton trop discret",
    person: claude.getPerson("amartin"),
  });
  claude.close();
  await designMd(vincent, "- Police Inter, titres en 600.\n- Ton chaleureux, tutoiement interdit.\n- Les boutons principaux sont pleins.\n- La semaine commence le lundi.");

  const plainProject = await call(plain.url, {})<{ id: string }>("POST", "/api/projects", { title: "Plain" });
  plainProjectId = plainProject.id;
  plainPageId = (await call(plain.url, {})<{ id: string }>("POST", `/api/projects/${plainProjectId}/pages`, { title: "Accueil", files: filesOf("Plain", "home.html") })).id;
  await call(plain.url, {})("PUT", `/api/projects/${plainProjectId}/design-md`, { content: "- One rule" });
}, 90_000);

afterAll(async () => {
  await browser?.close();
  await sso?.close();
  await plain?.stop();
  rmSync(webDir, { recursive: true, force: true });
  rmSync(dataDir, { recursive: true, force: true });
});

async function open(headers: Record<string, string>, base: string, route: string): Promise<Page> {
  const context = await browser.newContext({ extraHTTPHeaders: headers, viewport: { width: 1440, height: 900 } });
  const tab = await context.newPage();
  await tab.goto(`${base}/#/${route}`);
  return tab;
}

it("names who made each version in an artboard's history, Terminal and pre-SSO versions without a name", async () => {
  const tab = await open(vincent, sso.url, `pages/${historyPageId}`);
  await tab.getByRole("button", { name: "Historique de home.html" }).click();
  const rows = tab.getByRole("dialog", { name: "Historique de home.html" }).getByTestId("history-version");
  await expect.poll(() => rows.count()).toBe(5);
  const metas = (await rows.allInnerTexts()).map((text) => text.split("\n").filter(Boolean)[1]);
  expect(metas[0]).toMatch(/^Restauration · Ariane Martin · /);
  expect(metas[1]).toMatch(/^Toi · /);
  expect(metas[2]).toMatch(/^Claude · fil « Bouton trop discret », demandé par Ariane Martin · /);
  expect(metas[3]).toMatch(/^Terminal · /);
  expect(metas[4]).toMatch(/^Création · /);
  expect(metas[4]).not.toMatch(/Toi|Ariane|Vincent/);
}, 60_000);

it("says in the page menu who created each page, and for whom Claude did", async () => {
  const tab = await open(vincent, sso.url, `pages/${historyPageId}`);
  await tab.getByRole("button", { name: "Parcours" }).first().click();
  const menu = tab.getByRole("menu", { name: "Pages du projet Acme" });
  const item = (title: string) => menu.getByRole("menuitem", { name: new RegExp(`^${title}`) });
  await expect.poll(() => item("Erreurs").count()).toBe(1);
  expect(await item("Onboarding").innerText()).toContain("créée par Toi");
  expect(await item("Profil médecin").innerText()).toContain("créée par Ariane Martin");
  expect(await item("Erreurs").innerText()).toContain("créée par Claude · pour Ariane Martin");
  expect(await item("Page de Claude seule").innerText()).toContain("créée par Claude");
  expect(await item("Page de Claude seule").innerText()).not.toContain("pour");
  expect(await item("Hier").innerText()).not.toContain("créée par");
}, 60_000);

it("says who deleted each artboard, or who asked Claude to", async () => {
  const tab = await open(vincent, sso.url, `pages/${deletionPageId}`);
  await tab.getByRole("button", { name: "Onboarding" }).first().click();
  await tab.getByRole("menuitem", { name: /Artboards supprimés/ }).click();
  const list = tab.getByRole("dialog", { name: "Artboards supprimés" });
  const entry = (file: string) => list.getByTestId("deleted-artboard").filter({ hasText: file });
  await entry("ecran-4.html").waitFor();
  expect(await entry("ecran-4.html").innerText()).toMatch(/Supprimé par Claude · fil « Trop d'étapes », demandé par Toi · /);
  expect(await entry("ecran-5.html").innerText()).toMatch(/Supprimé par Ariane Martin · /);
  const unnamed = await entry("ecran-6.html").innerText();
  expect(unnamed).toMatch(/\n[^\n]*/);
  expect(unnamed).not.toContain("Supprimé par");
}, 60_000);

it("shows on the DESIGN.md screen who last changed it and who wrote each rule", async () => {
  const tab = await open(vincent, sso.url, `projects/${projectId}/design-md`);
  await expect.poll(() => tab.getByTestId("design-md-status").textContent()).toBe("Modifié par Toi · aujourd'hui");
  const origins = await tab.getByTestId("rules").locator("li").evaluateAll((items) => items.map((li) => li.children[1].textContent));
  expect(origins).toEqual([
    "Création du projet",
    "Ariane Martin · aujourd'hui",
    "Claude · fil « Bouton trop discret » · demandé par Ariane Martin · aujourd'hui",
    "Toi · aujourd'hui",
  ]);

  const seenByAriane = await open(ariane, sso.url, `projects/${projectId}/design-md`);
  await expect.poll(() => seenByAriane.getByTestId("design-md-status").textContent()).toBe("Modifié par Vincent Peraud · aujourd'hui");
}, 60_000);

it("keeps today's labels without SSO", async () => {
  const tab = await open({}, plain.url, `projects/${plainProjectId}/design-md`);
  await expect.poll(() => tab.getByTestId("design-md-status").textContent()).toBe("Dernière modification par toi · aujourd'hui");
  expect(await tab.getByTestId("rules").textContent()).toContain("Toi · création du projet");

  const canvas = await open({}, plain.url, `pages/${plainPageId}`);
  await canvas.getByRole("button", { name: "Accueil" }).first().click();
  const menu = canvas.getByRole("menu", { name: "Pages du projet Plain" });
  await menu.waitFor();
  expect(await menu.innerText()).not.toContain("créée par");
}, 60_000);
