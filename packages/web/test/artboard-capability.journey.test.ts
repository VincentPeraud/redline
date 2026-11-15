import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { copyBuiltWeb } from "./builtWeb.js";
import { type Browser, type Frame } from "playwright";
import { afterAll, beforeAll, expect, it } from "vitest";
import type { Page, Project } from "@redline/shared";
import { startServer, type RunningServer } from "@redline/server";
import { launchBrowser } from "./journeyBrowser.js";

const HUMAN = "h".repeat(32);
const MACHINE = "m".repeat(32);
/** Expires after 2 s and is renewed after 1 s, so a few seconds of waiting cross both. */
const LIFETIME_MS = 2000;
const sso = { "x-redline-proxy-secret": HUMAN, "remote-user": "amartin", "remote-name": "Ariane Martin", "remote-email": "ariane@example.com" };

let server: RunningServer;
let browser: Browser;
let webDir: string;
let dataDir: string;

beforeAll(async () => {
  webDir = mkdtempSync(join(tmpdir(), "redline-web-"));
  dataDir = mkdtempSync(join(tmpdir(), "redline-data-"));
  copyBuiltWeb(webDir);
  server = await startServer({ dataDir, port: 0, artboardPort: 0, host: "127.0.0.1", webDir, authMode: "proxy", firstAdminEmail: "ariane@example.com", proxySecrets: { human: HUMAN, machine: MACHINE }, artboardCapabilityLifetimeMs: LIFETIME_MS });
  browser = await launchBrowser();
}, 60_000);

afterAll(async () => {
  await browser?.close();
  await server?.close();
  rmSync(webDir, { recursive: true, force: true });
  rmSync(dataDir, { recursive: true, force: true });
});

const api = (path: string, body: unknown) => fetch(server.url + path, { method: "POST", headers: { ...sso, "content-type": "application/json" }, body: JSON.stringify(body) });
const html = (title: string) => `<!doctype html><body style="margin:0"><h1>${title}</h1></body>`;

it("keeps an open page rendering past the capability's lifetime, without reloading it, and loads new artboards with the renewed one", async () => {
  const project = (await (await api("/api/projects", { title: "Acme" })).json()) as Project;
  const page = (await (await api(`/api/projects/${project.id}/pages`, { title: "Flow", files: { "home.html": html("Version one") } })).json()) as Page;

  const context = await browser.newContext({ extraHTTPHeaders: sso });
  const tab = await context.newPage();
  const navigations: string[] = [];
  tab.on("framenavigated", (frame: Frame) => frame !== tab.mainFrame() && navigations.push(frame.url()));

  await tab.goto(`${server.url}/#/pages/${page.id}`);
  const artboard = tab.frameLocator("iframe");
  await expect.poll(() => artboard.locator("h1").textContent()).toBe("Version one");
  const firstUrl = navigations[0]!;
  expect(firstUrl).toContain("/c/");

  // Past the expiry of the capability the frame was loaded with, and past one renewal.
  await tab.waitForTimeout(LIFETIME_MS + 1500);
  expect(await artboard.locator("h1").textContent()).toBe("Version one");
  expect(navigations).toEqual([firstUrl]);

  // A change remounts the artboard: it loads with the renewed capability, which the listener still accepts.
  await api(`/api/pages/${page.id}/versions`, { files: { "home.html": html("Version two") }, message: "Second", origin: "thread" });
  await expect.poll(() => artboard.locator("h1").textContent()).toBe("Version two");
  expect(navigations[1]).not.toBe(firstUrl);
  expect(navigations[1]).toContain("/c/");
  await context.close();
}, 30_000);
