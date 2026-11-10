import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { build } from "vite";
import { type Browser, type Page } from "playwright";
import { launchBrowser } from "./journeyBrowser.js";
import WebSocket from "ws";
import { afterAll, beforeAll, expect, it, vi } from "vitest";
import { AGENT_API_PREFIX, AGENT_ENDPOINT, MANIFEST_PATH, PROTOCOL_VERSION, type WorkItem } from "@redline/shared";
import { admitSsoPeople } from "../../server/test/sso-people.js";
import { startServer, type RunningServer } from "../../server/src/start.js";
import { admitSsoPeople } from "../../server/test/sso-people.js";
import { startTestServer, type TestServer } from "@redline/server/test-harness";

const webRoot = fileURLToPath(new URL("..", import.meta.url));
const HUMAN = "h".repeat(32);
const person = (user: string, name: string) => ({ "x-redline-proxy-secret": HUMAN, "remote-user": user, "remote-name": name, "remote-email": `${user}@example.com` });
const ariane = person("amartin", "Ariane Martin");
const vincent = person("vperaud", "Vincent Peraud");
const beforeSso = {};
const rules = ["- Police Inter, titres en 600.", "- Ton chaleureux, tutoiement interdit.", "- Les boutons principaux sont pleins.", "- La semaine commence le lundi."];

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
let unnamedDeletionPageId: string;
let plainProjectId: string;
let plainPageId: string;

const call = (base: string, headers: Record<string, string>) => async <T>(method: string, path: string, body?: unknown): Promise<T> => {
  const res = await fetch(base + path, { method, headers: { "content-type": "application/json", ...headers }, body: body === undefined ? undefined : JSON.stringify(body) });
  expect(res.status).toBeLessThan(300);
  return res.json() as Promise<T>;
};

const MACHINE = "m".repeat(32);
let agent: WebSocket;
const works = new Map<string, WorkItem>();

/** A project agent connected to the SSO server, collecting the work items it is sent by the first thread each one answers. */
async function connectAgent(): Promise<void> {
  const { token } = await call(sso.url, vincent)<{ token: string }>("GET", "/api/agent-token");
  agent = new WebSocket(sso.url.replace(/^http/, "ws") + AGENT_ENDPOINT, { headers: { "x-redline-proxy-secret": MACHINE } });
  agent.on("message", (data) => {
    const message = JSON.parse(String(data)) as { type: string; item?: WorkItem };
    if (message.type === "work" && message.item) works.set(message.item.threads[0].threadId, message.item);
  });
  await new Promise<void>((resolve) => agent.on("open", () => resolve()));
  agent.send(JSON.stringify({ type: "hello", token, protocolVersion: PROTOCOL_VERSION, machine: "m", folder: "/f", kind: "project", projectId }));
}

/** Someone comments on a page, Claude (the agent) works on it through `publish`, then the run ends. */
async function claudeRun(pageId: string, who: Record<string, string>, comment: { artboard: string; body: string }, publish: (workId: string) => Promise<void>): Promise<void> {
  const thread = await call(sso.url, who)<{ id: string }>("POST", `/api/pages/${pageId}/threads`, { ...comment, selector: "h1", xPct: 10, yPct: 20 });
  const item = await vi.waitFor(() => works.get(thread.id) ?? Promise.reject(new Error("no work yet")), { timeout: 5000, interval: 20 });
  await publish(item.id);
  agent.send(JSON.stringify({ type: "work-done", workId: item.id }));
}

beforeAll(async () => {
  webDir = mkdtempSync(join(tmpdir(), "redline-web-"));
  dataDir = mkdtempSync(join(tmpdir(), "redline-signed-history-"));
  await build({ root: webRoot, logLevel: "silent", build: { outDir: webDir, emptyOutDir: true } });
  // Before the SSO the server had no accounts: what nobody signed is written then, on the same data.
  const beforeSsoServer = await startServer({ dataDir, port: 0, artboardPort: 0, host: "127.0.0.1" });
  const old = call(beforeSsoServer.url, beforeSso);
  projectId = (await old<{ id: string }>("POST", "/api/projects", { title: "Acme" })).id;
  const oldPage = (title: string, files = filesOf(title, "home.html")) => old<{ id: string; version: { id: string } }>("POST", `/api/projects/${projectId}/pages`, { title, files });
  await old("PUT", `/api/projects/${projectId}/design-md`, { content: rules[0] });
  const history = await oldPage("Parcours");
  await oldPage("Hier");
  const unnamedDeletions = await oldPage("Étapes retirées", filesOf("Étapes", "ecran-1.html", "ecran-6.html"));
  unnamedDeletionPageId = unnamedDeletions.id;
  await old("POST", `/api/pages/${unnamedDeletions.id}/versions`, { files: filesOf("Étapes", "ecran-1.html"), message: "Retire l'écran 6", origin: "user" });
  await beforeSsoServer.close();

  sso = await startServer({
    dataDir,
    port: 0,
    artboardPort: 0,
    host: "127.0.0.1",
    webDir,
    firstAdminEmail: "amartin@example.com",
    proxySecrets: { human: HUMAN, machine: MACHINE },
    identity: { userHeader: "remote-user", nameHeader: "remote-name", emailHeader: "remote-email" },
  });
  plain = await startTestServer({ webDir });
  browser = await launchBrowser();

  await admitSsoPeople(sso.url, [ariane, vincent]);

  const page = (title: string, headers: Record<string, string>, files = filesOf(title, "home.html")) =>
    call(sso.url, headers)<{ id: string; version: { id: string } }>("POST", `/api/projects/${projectId}/pages`, { title, files });

  // DESIGN.md: Ariane's rule follows the one from before the SSO (Claude's and Vincent's follow below).
  const designMd = (headers: Record<string, string>, content: string) => call(sso.url, headers)("PUT", `/api/projects/${projectId}/design-md`, { content });
  await designMd(ariane, rules.slice(0, 2).join("\n"));

  await connectAgent();
  const asAgent = async <T>(method: string, path: string, body: unknown): Promise<T> => {
    const { token } = await call(sso.url, vincent)<{ token: string }>("GET", "/api/agent-token");
    const res = await fetch(sso.url + AGENT_API_PREFIX + path, {
      method,
      headers: { authorization: `Bearer ${token}`, "content-type": "application/json", "x-redline-proxy-secret": MACHINE },
      body: JSON.stringify(body),
    });
    expect(res.status).toBeLessThan(300);
    return res.json() as Promise<T>;
  };

  // The history of home.html on "Parcours": created before the SSO, then Terminal, Claude for Ariane, Vincent by hand, Ariane's restoration.
  historyPageId = history.id;
  const terminal = await asAgent<{ id: string }>("POST", `/pages/${history.id}/versions`, {
    files: filesOf("Terminal", "home.html"),
    message: "Ajuste les marges de l'artboard",
    origin: "terminal",
    baseVersionId: history.version.id,
  });
  await claudeRun(history.id, ariane, { artboard: "home.html", body: "Bouton trop discret" }, async (workId) => {
    await asAgent("POST", `/pages/${history.id}/versions`, {
      files: filesOf("Claude", "home.html"),
      message: "Bouton principal plein",
      origin: "thread",
      baseVersionId: terminal.id,
      workId,
      designMd: { content: rules.slice(0, 3).join("\n"), base: rules.slice(0, 2).join("\n") },
    });
    await asAgent("POST", `/pages/${history.id}/siblings`, { title: "Erreurs", workId });
  });
  await call(sso.url, vincent)("POST", `/api/pages/${history.id}/versions`, { files: filesOf("Manual", "home.html"), message: "Retouche à la main", origin: "user" });
  await call(sso.url, ariane)("POST", `/api/pages/${history.id}/versions/${history.version.id}/restore`, {});
  await designMd(vincent, rules.join("\n"));

  // Pages for the page menu and the deleted artboards.
  await asAgent("POST", `/pages/${history.id}/siblings`, { title: "Page de Claude seule" });
  await page("Profil médecin", ariane);
  const deletions = await page("Onboarding", vincent, filesOf("Onboarding", "ecran-1.html", "ecran-4.html", "ecran-5.html", "ecran-6.html"));
  deletionPageId = deletions.id;
  await claudeRun(deletions.id, vincent, { artboard: "ecran-1.html", body: "Trop d'étapes" }, async (workId) => {
    await asAgent("POST", `/pages/${deletions.id}/versions`, {
      files: filesOf("Onboarding", "ecran-1.html", "ecran-5.html", "ecran-6.html"),
      message: "Trop d'étapes",
      origin: "thread",
      baseVersionId: deletions.version.id,
      workId,
      confirmRemovals: true,
    });
  });
  await call(sso.url, ariane)("POST", `/api/pages/${deletions.id}/versions`, { files: filesOf("Onboarding", "ecran-1.html", "ecran-6.html"), message: "Retire l'écran 5", origin: "user" });

  const plainProject = await call(plain.url, {})<{ id: string }>("POST", "/api/projects", { title: "Plain" });
  plainProjectId = plainProject.id;
  plainPageId = (await call(plain.url, {})<{ id: string }>("POST", `/api/projects/${plainProjectId}/pages`, { title: "Accueil", files: filesOf("Plain", "home.html") })).id;
  await call(plain.url, {})("PUT", `/api/projects/${plainProjectId}/design-md`, { content: "- One rule" });
}, 90_000);

afterAll(async () => {
  agent?.close();
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
  const unnamedTab = await open(vincent, sso.url, `pages/${unnamedDeletionPageId}`);
  await unnamedTab.getByRole("button", { name: "Étapes retirées" }).first().click();
  await unnamedTab.getByRole("menuitem", { name: /Artboards supprimés/ }).click();
  const unnamedEntry = unnamedTab.getByRole("dialog", { name: "Artboards supprimés" }).getByTestId("deleted-artboard").filter({ hasText: "ecran-6.html" });
  await unnamedEntry.waitFor();
  const unnamed = await unnamedEntry.innerText();
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
