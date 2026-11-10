import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { build } from "vite";
import { type Browser, type Page } from "playwright";
import { launchBrowser } from "./journeyBrowser.js";
import { afterAll, beforeAll, expect, it } from "vitest";
import { MANIFEST_PATH } from "@redline/shared";
import { startServer, type RunningServer } from "../../server/src/start.js";
import { admitSsoPeople } from "../../server/test/sso-people.js";
import { startTestServer, type TestServer } from "@redline/server/test-harness";

const webRoot = fileURLToPath(new URL("..", import.meta.url));
const HUMAN = "h".repeat(32);
const person = (user: string, name: string) => ({ "x-redline-proxy-secret": HUMAN, "remote-user": user, "remote-name": name, "remote-email": `${user}@example.com` });
const ariane = person("amartin", "Ariane Martin");
const vincent = person("vperaud", "Vincent Peraud");
const beforeSso = {};
const files = { "home.html": "<h1>Home</h1>", [MANIFEST_PATH]: JSON.stringify({ artboards: [{ file: "home.html", x: 0, y: 0 }] }) };

let webDir: string;
let dataDir: string;
let browser: Browser;
let sso: RunningServer;
let plain: TestServer;
let pageId: string;
let plainPageId: string;

const call = (base: string, headers: Record<string, string>) => async <T>(method: string, path: string, body?: unknown): Promise<T> =>
  (await fetch(base + path, { method, headers: { "content-type": "application/json", ...headers }, body: body === undefined ? undefined : JSON.stringify(body) })).json() as Promise<T>;

async function createPage(base: string, headers: Record<string, string>): Promise<string> {
  const api = call(base, headers);
  const project = await api<{ id: string }>("POST", "/api/projects", { title: "Acme" });
  return (await api<{ id: string }>("POST", `/api/projects/${project.id}/pages`, { title: "Home", files })).id;
}
const threadBody = (body: string, held = false) => ({ artboard: "home.html", selector: "h1", xPct: 10, yPct: 20, body, held });

beforeAll(async () => {
  webDir = mkdtempSync(join(tmpdir(), "redline-web-"));
  dataDir = mkdtempSync(join(tmpdir(), "redline-signed-"));
  await build({ root: webRoot, logLevel: "silent", build: { outDir: webDir, emptyOutDir: true } });
  // Before the SSO the server had no accounts: the old comment is written then, on the same data.
  const beforeSsoServer = await startServer({ dataDir, port: 0, artboardPort: 0, host: "127.0.0.1" });
  pageId = await createPage(beforeSsoServer.url, beforeSso);
  await call(beforeSsoServer.url, beforeSso)("POST", `/api/pages/${pageId}/threads`, threadBody("Old comment"));
  await beforeSsoServer.close();
  sso = await startServer({
    dataDir,
    port: 0,
    artboardPort: 0,
    host: "127.0.0.1",
    webDir,
    firstAdminEmail: "amartin@example.com",
    proxySecrets: { human: HUMAN, machine: "m".repeat(32) },
    identity: { userHeader: "remote-user", nameHeader: "remote-name", emailHeader: "remote-email" },
  });
  plain = await startTestServer({ webDir });
  await admitSsoPeople(sso.url, [ariane, vincent]);
  plainPageId = await createPage(plain.url, {});
  browser = await launchBrowser();
}, 60_000);

afterAll(async () => {
  await browser?.close();
  await sso?.close();
  await plain?.stop();
  rmSync(webDir, { recursive: true, force: true });
  rmSync(dataDir, { recursive: true, force: true });
});

async function open(headers: Record<string, string>, base: string, page: string): Promise<Page> {
  const context = await browser.newContext({ extraHTTPHeaders: headers, viewport: { width: 1440, height: 900 } });
  const tab = await context.newPage();
  await tab.goto(`${base}/#/pages/${page}`);
  await tab.getByRole("tab", { name: /^Commentaires/ }).click();
  return tab;
}

it("signs thread messages: Toi for the viewer, the name for the other person, Utilisateur inconnu before the SSO, each on its own line", async () => {
  const arianeApi = call(sso.url, ariane);
  const thread = await arianeApi<{ id: string }>("POST", `/api/pages/${pageId}/threads`, threadBody("Make the button bigger"));
  await call(sso.url, vincent)("POST", `/api/threads/${thread.id}/messages`, { body: "Keep the outline on hover" });

  const tab = await open(vincent, sso.url, pageId);
  const card = tab.locator("article").filter({ hasText: "Make the button bigger" });
  await card.waitFor();
  expect(await card.getByTestId("message-author").allTextContents()).toEqual(["Ariane Martin", "Toi"]);
  expect(await card.innerText()).not.toContain("—");
  const author = card.getByTestId("message-author").first();
  expect(await author.evaluate((el) => ({ display: getComputedStyle(el).display, size: getComputedStyle(el).fontSize, weight: getComputedStyle(el).fontWeight }))).toEqual({ display: "block", size: "13px", weight: "600" });

  const old = tab.locator("article").filter({ hasText: "Old comment" });
  expect(await old.getByTestId("message-author").allTextContents()).toEqual(["Utilisateur inconnu"]);

  const seenByAriane = await open(ariane, sso.url, pageId);
  await seenByAriane.locator("article").filter({ hasText: "Make the button bigger" }).waitFor();
  expect(await seenByAriane.locator("article").filter({ hasText: "Make the button bigger" }).getByTestId("message-author").allTextContents()).toEqual(["Toi", "Vincent Peraud"]);
}, 60_000);

it("signs held comments", async () => {
  await call(sso.url, ariane)("POST", `/api/pages/${pageId}/threads`, threadBody("Shorten the title", true));
  const tab = await open(vincent, sso.url, pageId);
  const held = tab.getByTestId("held-thread").filter({ hasText: "Shorten the title" });
  await held.waitFor();
  expect(await held.getByTestId("message-author").allTextContents()).toEqual(["Ariane Martin"]);
}, 60_000);

it("signs conversation bubbles and names who started each conversation in the list", async () => {
  const api = call(sso.url, ariane);
  const conversation = await api<{ id: string }>("POST", `/api/pages/${pageId}/conversations`, { title: "Error pages" });
  await api("POST", `/api/conversations/${conversation.id}/messages`, { body: "Create the error pages" });
  await call(sso.url, vincent)("POST", `/api/conversations/${conversation.id}/messages`, { body: "Add a denied page" });

  const tab = await open(vincent, sso.url, pageId);
  await tab.getByRole("tab", { name: "Conversation", exact: true }).click();
  const panel = tab.getByTestId("conversations");
  await expect.poll(() => panel.getByTestId("conversation-message").count()).toBe(2);
  expect(await panel.getByTestId("message-author").allTextContents()).toEqual(["Ariane Martin", "Toi"]);
  expect(await panel.getByTestId("conversation-starter").innerText()).toMatch(/^Ariane Martin · /);
  await panel.getByRole("button", { name: "Conversation", exact: true }).click();
  expect(await panel.getByRole("option", { name: /Error pages/ }).innerText()).toContain("Ariane Martin · 2 échanges");
}, 60_000);

it("keeps today's labels without SSO", async () => {
  const api = call(plain.url, {});
  await api("POST", `/api/pages/${plainPageId}/threads`, threadBody("Plain comment"));
  const tab = await open({}, plain.url, plainPageId);
  const card = tab.locator("article").filter({ hasText: "Plain comment" });
  await card.waitFor();
  expect(await card.getByTestId("message-author").allTextContents()).toEqual(["Toi"]);
}, 60_000);
