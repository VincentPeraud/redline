import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { build } from "vite";
import { type Browser } from "playwright";
import { launchBrowser } from "./journeyBrowser.js";
import { afterAll, beforeAll, expect, it } from "vitest";
import { MANIFEST_PATH } from "@redline/shared";
import { startServer, type RunningServer } from "../../server/src/start.js";
import { admitSsoPeople } from "../../server/test/sso-people.js";
import { startTestServer, type TestServer } from "@redline/server/test-harness";

const webRoot = fileURLToPath(new URL("..", import.meta.url));
const HUMAN = "h".repeat(32);
const sso = (user: string, name: string) => ({ "x-redline-proxy-secret": HUMAN, "remote-user": user, "remote-name": name, "remote-email": `${user}@example.com` });
const ariane = sso("amartin", "Ariane Martin");
const vincent = sso("vperaud", "Vincent Peraud");
const anonymous = {};

let webDir: string;
let dataDir: string;
let browser: Browser;
let server: RunningServer;
let plain: TestServer;

const files = { "home.html": "<h1>Home</h1>", [MANIFEST_PATH]: JSON.stringify({ artboards: [{ file: "home.html", x: 0, y: 0 }] }) };

/** Creates a project and page, then one held thread per title, each written with the headers at the same index. */
async function seed(base: string, authors: Record<string, string>[], titles: string[]): Promise<void> {
  const post = async <T,>(headers: Record<string, string>, path: string, body: unknown) =>
    (await (await fetch(base + path, { method: "POST", headers: { "content-type": "application/json", ...headers }, body: JSON.stringify(body) })).json()) as T;
  const project = await post<{ id: string }>(authors[0], "/api/projects", { title: "Acme" });
  const page = await post<{ id: string }>(authors[0], `/api/projects/${project.id}/pages`, { title: "Home", files });
  for (const [i, title] of titles.entries()) {
    await post(authors[i], `/api/pages/${page.id}/threads`, { artboard: "home.html", selector: "h1", xPct: 10, yPct: 20, body: title, held: true });
  }
}

beforeAll(async () => {
  webDir = mkdtempSync(join(tmpdir(), "redline-web-"));
  dataDir = mkdtempSync(join(tmpdir(), "redline-sso-"));
  await build({ root: webRoot, logLevel: "silent", build: { outDir: webDir, emptyOutDir: true } });
  // Before the SSO the server had no accounts: the "Before SSO" session is started then, on the same data.
  const beforeSso = await startServer({ dataDir, port: 0, artboardPort: 0, host: "127.0.0.1" });
  await seed(beforeSso.url, [anonymous], ["Before SSO"]);
  await beforeSso.close();
  server = await startServer({
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
  await admitSsoPeople(server.url, [ariane, vincent]);
  await seed(server.url, [ariane, vincent], ["Mine", "His"]);
  await seed(plain.url, [{}], ["Plain"]);
  browser = await launchBrowser();
}, 60_000);

afterAll(async () => {
  await browser?.close();
  await server?.close();
  await plain?.stop();
  rmSync(webDir, { recursive: true, force: true });
  rmSync(dataDir, { recursive: true, force: true });
});

it("names who started each session with initials, and filters the viewer's own with 'Mes sessions'", async () => {
  const context = await browser.newContext({ extraHTTPHeaders: ariane, viewport: { width: 1440, height: 900 } });
  const tab = await context.newPage();
  await tab.goto(`${server.url}/#/sessions`);
  const rows = tab.getByTestId("session-row");
  await expect.poll(() => rows.count()).toBe(3);

  expect(await tab.getByText("Lancé par", { exact: true }).count()).toBe(1);
  const textOf = (title: string) => rows.filter({ hasText: title }).textContent();
  expect(await textOf("Mine")).toContain("AMToi");
  expect(await textOf("His")).toContain("VPVincent Peraud");
  const unknown = (await textOf("Before SSO"))!;
  expect(unknown).toContain("—");
  expect(unknown).not.toContain("Utilisateur inconnu");

  const mine = tab.getByRole("button", { name: /^Mes sessions/ });
  expect(await mine.textContent()).toBe("Mes sessions · 1");
  await mine.click();
  await expect.poll(() => rows.count()).toBe(1);
  expect(await rows.first().textContent()).toContain("Mine");
  await mine.click();
  await expect.poll(() => rows.count()).toBe(3);
  await context.close();
});

it("has no 'Lancé par' column and no 'Mes sessions' filter without an SSO", async () => {
  const tab = await browser.newPage({ viewport: { width: 1440, height: 900 } });
  await tab.goto(`${plain.url}/#/sessions`);
  const row = tab.getByTestId("session-row");
  await expect.poll(() => row.count()).toBe(1);
  expect(await tab.getByText("Lancé par", { exact: true }).count()).toBe(0);
  expect(await tab.getByRole("button", { name: /^Mes sessions/ }).count()).toBe(0);
  await tab.close();
});
