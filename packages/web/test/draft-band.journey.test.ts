import Database from "better-sqlite3";
import { randomUUID } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { copyBuiltWeb } from "./builtWeb.js";
import type { Browser, Page } from "playwright";
import { afterAll, beforeAll, expect, it } from "vitest";
import { CORE_TOKENS, MANIFEST_PATH, type DesignSystem, type Project, type ShareLink } from "@redline/shared";
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
const tokensCss = (extra = "") => `:root {\n${CORE_TOKENS.map((t) => `  ${t}: #112233;`).join("\n")}\n${extra}}\n`;

beforeAll(async () => {
  webDir = mkdtempSync(join(tmpdir(), "redline-web-"));
  dataDir = mkdtempSync(join(tmpdir(), "redline-draft-band-"));
  copyBuiltWeb(webDir);
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


const manifestOf = (files: string[], designSystem?: string) => JSON.stringify({ ...(designSystem && { designSystem }), artboards: files.map((file, i) => ({ file, title: file, x: i * 300, y: 0, width: 200, height: 100 })) });

async function cookieOf(email: string): Promise<string> {
  const res = await fetch(`${server.url}/api/session`, { method: "POST", headers: JSON_HEADERS, body: JSON.stringify({ email, password: PASSWORD }) });
  return (res.headers.get("set-cookie") ?? "").split(";")[0].split("=")[1];
}

async function api(method: string, path: string, body?: unknown): Promise<Response> {
  const cookie = `redline_session=${await cookieOf("ariane@example.com")}`;
  return fetch(server.url + path, { method, headers: { ...JSON_HEADERS, cookie }, body: method === "GET" ? undefined : JSON.stringify(body ?? {}) });
}

async function memberTab(width = 1440, height = 900): Promise<Page> {
  const context = await browser.newContext({ viewport: { width, height } });
  await context.addCookies([{ name: "redline_session", value: await cookieOf("ariane@example.com"), url: server.url }]);
  return context.newPage();
}

const publishInDraft = (ds: DesignSystem, extra: string) =>
  api("POST", `/api/pages/${ds.pageId}/versions`, { files: { "tokens.css": tokensCss(extra), "manifest.json": manifestOf([]) }, message: "Tweak", origin: "thread" });

it("shows the draft band to a member and to a link visitor only while the draft has changes, and reloads it live", async () => {
  const ds = (await (await api("POST", "/api/design-systems", { title: "Locoum", files: { "tokens.css": tokensCss(), "manifest.json": manifestOf([]) } })).json()) as DesignSystem;
  const project = (await (await api("POST", "/api/projects", { title: "App", designSystem: ds.id })).json()) as Project;
  const page = (await (await api("POST", `/api/projects/${project.id}/pages`, { title: "Authentification", files: { "a.html": "<!doctype html><body>Hi</body>", [MANIFEST_PATH]: manifestOf(["a.html"], ds.id) } })).json()) as { id: string };
  const link = (await (await api("POST", `/api/pages/${page.id}/links`, { kind: "generic", name: "Client", level: "read" })).json()) as ShareLink;

  const member = await memberTab();
  await member.goto(`${server.url}/#/pages/${page.id}`);
  await member.getByText("Authentification").first().waitFor();
  // Following the latest diffusion: no band, even with pending changes.
  await publishInDraft(ds, "  --brand: #123456;\n");
  expect(await member.getByTestId("draft-banner").count()).toBe(0);

  await api("PUT", `/api/projects/${project.id}/design-system`, { followsDraft: true });
  await member.reload();
  const band = member.getByTestId("draft-banner");
  await band.waitFor();
  const text = (await band.textContent()) ?? "";
  expect(text).toContain("Cette page utilise le brouillon de Locoum");
  expect(text).toMatch(/\d+ modifications? de Locoum pas encore diffusées? s'applique(nt)? à ce projet\. Elles? peu(t|vent) encore changer\./);
  await band.getByRole("button", { name: "Ouvrir Locoum" }).click();
  await member.waitForURL(new RegExp(`#/design-systems/${ds.id}`));

  const visitor = await (await browser.newContext()).newPage();
  await visitor.goto(`${server.url}/s/${link.token}`);
  const visitorBand = visitor.getByTestId("draft-banner");
  await visitorBand.waitFor();
  expect(await visitorBand.textContent()).toContain("Cette page utilise le brouillon de Locoum");
  expect(await visitorBand.getByRole("button").count()).toBe(0);

  // A diffusion empties the difference: the band goes away on both, without a reload.
  await member.goto(`${server.url}/#/pages/${page.id}`);
  await member.getByTestId("draft-banner").waitFor();
  expect((await api("POST", `/api/design-systems/${ds.id}/diffusions`, {})).status).toBeLessThan(300);
  await member.getByTestId("draft-banner").waitFor({ state: "detached" });
  await visitorBand.waitFor({ state: "detached" });

  // A new draft change reaches the open page by itself and brings the band back with its count.
  await publishInDraft(ds, "  --brand: #654321;\n");
  await member.getByTestId("draft-banner").waitFor();
  await visitorBand.waitFor();
}, 60_000);
