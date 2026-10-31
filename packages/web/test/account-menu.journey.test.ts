import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { build } from "vite";
import { type Browser, type BrowserContext, type Page } from "playwright";
import { launchBrowser } from "./journeyBrowser.js";
import { afterAll, beforeAll, expect, it } from "vitest";
import { MANIFEST_PATH } from "@redline/shared";
import { startServer, type RunningServer } from "../../server/src/start.js";
import { startTestServer, type TestServer } from "@redline/server/test-harness";

const webRoot = fileURLToPath(new URL("..", import.meta.url));
const HUMAN = "h".repeat(32);
const LOGOUT = "https://auth.example.com/logout";
const ssoHeaders = { "x-redline-proxy-secret": HUMAN, "remote-user": "amartin", "remote-name": "Ariane Martin", "remote-email": "ariane@example.com" };

let webDir: string;
let dataDir: string;
let browser: Browser;
let sso: RunningServer;
let plain: TestServer;
let pageId: string;
let plainPageId: string;

const files = { "home.html": "<h1>Home</h1>", [MANIFEST_PATH]: JSON.stringify({ artboards: [{ file: "home.html", x: 0, y: 0 }] }) };

async function createPage(base: string, headers: Record<string, string>): Promise<string> {
  const post = (path: string, body: unknown) => fetch(base + path, { method: "POST", headers: { "content-type": "application/json", ...headers }, body: JSON.stringify(body) });
  const project = (await (await post("/api/projects", { title: "Acme" })).json()) as { id: string };
  return ((await (await post(`/api/projects/${project.id}/pages`, { title: "Home", files })).json()) as { id: string }).id;
}

beforeAll(async () => {
  webDir = mkdtempSync(join(tmpdir(), "redline-web-"));
  dataDir = mkdtempSync(join(tmpdir(), "redline-sso-"));
  await build({ root: webRoot, logLevel: "silent", build: { outDir: webDir, emptyOutDir: true } });
  sso = await startServer({
    dataDir,
    port: 0,
    artboardPort: 0,
    host: "127.0.0.1",
    webDir,
    proxySecrets: { human: HUMAN, machine: "m".repeat(32) },
    identity: { userHeader: "remote-user", nameHeader: "remote-name", emailHeader: "remote-email", logoutUrl: LOGOUT },
  });
  plain = await startTestServer({ webDir });
  pageId = await createPage(sso.url, ssoHeaders);
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

async function signedInTab(options: { reducedMotion?: "reduce" } = {}): Promise<{ context: BrowserContext; tab: Page }> {
  const context = await browser.newContext({ extraHTTPHeaders: ssoHeaders, reducedMotion: options.reducedMotion });
  return { context, tab: await context.newPage() };
}

const open = (tab: Page) => tab.getByTestId("account-drawer").getAttribute("data-open");
const menuTransition = (tab: Page) => tab.locator("[role='menu']").evaluate((el) => getComputedStyle(el).transitionDuration);

it("shows the signed-in person at the bottom of the sidebar and signs out from the drawer menu", async () => {
  const { context, tab } = await signedInTab();
  await tab.goto(`${sso.url}/#/`);
  const block = tab.getByTestId("account-block");
  await expect.poll(() => block.innerText()).toContain("Ariane Martin");
  expect(await block.innerText()).toContain("ariane@example.com");
  expect(await block.innerText()).toContain("AM");
  expect(await open(tab)).toBe("false");
  await expect.poll(() => tab.getByRole("link", { name: "Se déconnecter" }).isVisible()).toBe(false);

  await block.click();
  expect(await open(tab)).toBe("true");
  expect(await block.getAttribute("aria-expanded")).toBe("true");
  const logout = tab.getByRole("menuitem", { name: "Se déconnecter" });
  await logout.waitFor();
  expect(await logout.getAttribute("href")).toBe(LOGOUT);
  await expect.poll(() => tab.evaluate(() => document.activeElement?.textContent)).toContain("Se déconnecter");

  await tab.keyboard.press("Escape");
  expect(await open(tab)).toBe("false");
  await expect.poll(() => tab.evaluate(() => document.activeElement?.getAttribute("data-testid"))).toBe("account-block");

  await block.click();
  expect(await open(tab)).toBe("true");
  await tab.getByRole("heading", { name: "Accueil" }).click();
  expect(await open(tab)).toBe("false");

  await block.click();
  await block.click();
  expect(await open(tab)).toBe("false");
  await context.close();
}, 60_000);

it("shows the initials at the right of the canvas header with the same menu", async () => {
  const { context, tab } = await signedInTab();
  await tab.goto(`${sso.url}/#/pages/${pageId}`);
  const pill = tab.getByTestId("account-pill");
  await expect.poll(() => pill.innerText()).toBe("AM");
  expect(await pill.getAttribute("aria-label")).toBe("Compte : Ariane Martin");
  expect(await open(tab)).toBe("false");

  await pill.click();
  expect(await open(tab)).toBe("true");
  const menu = tab.getByRole("menu", { name: "Compte" });
  expect(await menu.innerText()).toContain("ariane@example.com");
  expect(await tab.getByRole("menuitem", { name: "Se déconnecter" }).getAttribute("href")).toBe(LOGOUT);

  await tab.keyboard.press("Escape");
  expect(await open(tab)).toBe("false");
  await pill.press("ArrowDown");
  expect(await open(tab)).toBe("true");
  await tab.getByRole("button", { name: "Interagir (P)" }).click();
  expect(await open(tab)).toBe("false");
  await context.close();
}, 60_000);

it("animates the menu, and not under prefers-reduced-motion", async () => {
  const normal = await signedInTab();
  await normal.tab.goto(`${sso.url}/#/`);
  await normal.tab.getByTestId("account-block").waitFor();
  expect(await menuTransition(normal.tab)).toBe("0.2s");
  await normal.tab.getByTestId("account-block").click();
  expect(await menuTransition(normal.tab)).toBe("0.34s");
  await normal.context.close();

  const reduced = await signedInTab({ reducedMotion: "reduce" });
  await reduced.tab.goto(`${sso.url}/#/`);
  await reduced.tab.getByTestId("account-block").click();
  expect(await menuTransition(reduced.tab)).toBe("0s");
  await reduced.context.close();
}, 60_000);

it("shows neither the block nor the pill without SSO", async () => {
  const tab = await (await browser.newContext()).newPage();
  const meAnswered = tab.waitForResponse((response) => response.url().endsWith("/api/me"));
  await tab.goto(`${plain.url}/#/`);
  expect(await (await meAnswered).json()).toBeNull();
  await tab.getByRole("link", { name: "Agents" }).waitFor();
  expect(await tab.getByTestId("account-block").count()).toBe(0);
  await tab.goto(`${plain.url}/#/pages/${plainPageId}`);
  await tab.getByRole("button", { name: "Interagir (P)" }).waitFor();
  expect(await tab.getByTestId("account-pill").count()).toBe(0);
}, 60_000);

it("offers no sign-out without a logout URL", async () => {
  const noLogoutDir = mkdtempSync(join(tmpdir(), "redline-sso-"));
  const server = await startServer({ dataDir: noLogoutDir, port: 0, artboardPort: 0, host: "127.0.0.1", webDir, proxySecrets: { human: HUMAN, machine: "m".repeat(32) } });
  const context = await browser.newContext({ extraHTTPHeaders: ssoHeaders });
  const tab = await context.newPage();
  await tab.goto(`${server.url}/#/`);
  await tab.getByTestId("account-block").click();
  expect(await open(tab)).toBe("true");
  expect(await tab.getByRole("menu", { name: "Compte" }).innerText()).toContain("ariane@example.com");
  expect(await tab.getByRole("menuitem").count()).toBe(0);
  await context.close();
  await server.close();
  rmSync(noLogoutDir, { recursive: true, force: true });
}, 60_000);
