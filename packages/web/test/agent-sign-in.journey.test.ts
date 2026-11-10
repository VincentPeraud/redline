import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { build } from "vite";
import type { Browser } from "playwright";
import { afterAll, beforeAll, expect, it } from "vitest";
import { AGENT_API_PREFIX, type AgentTokenResponse } from "@redline/shared";
import { startServer, type RunningServer } from "../../server/src/start.js";
import { launchBrowser } from "./journeyBrowser.js";

const webRoot = fileURLToPath(new URL("..", import.meta.url));

let webDir: string;
let dataDir: string;
let browser: Browser;
let server: RunningServer;
let agentToken: string;

beforeAll(async () => {
  webDir = mkdtempSync(join(tmpdir(), "redline-web-"));
  dataDir = mkdtempSync(join(tmpdir(), "redline-agent-sign-in-"));
  await build({ root: webRoot, logLevel: "silent", build: { outDir: webDir, emptyOutDir: true } });
  let setupToken = "";
  server = await startServer({ dataDir, port: 0, artboardPort: 0, host: "127.0.0.1", webDir, authMode: "local", log: (line) => (setupToken = line.split("/#/setup/")[1] ?? setupToken) });
  const created = await fetch(`${server.url}/api/setup`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ token: setupToken.trim(), name: "Vincent Peraud", email: "vincent@example.com", password: "correct horse" }),
  });
  const cookie = created.headers.get("set-cookie")!.split(";")[0];
  agentToken = ((await (await fetch(`${server.url}/api/agent-token`, { headers: { cookie } })).json()) as AgentTokenResponse).token;
  browser = await launchBrowser();
}, 60_000);

afterAll(async () => {
  await browser?.close();
  await server?.close();
  rmSync(webDir, { recursive: true, force: true });
  rmSync(dataDir, { recursive: true, force: true });
});

const linkTo = async (path: string) => {
  const res = await fetch(`${server.url}${AGENT_API_PREFIX}/sign-in-link`, { method: "POST", headers: { authorization: `Bearer ${agentToken}`, "content-type": "application/json" }, body: JSON.stringify({ path }) });
  return ((await res.json()) as { url: string }).url;
};

it("signs a fresh browser in and lands on the asked path, then says a second use has expired", async () => {
  const url = await linkTo("#/accounts");
  const tab = await (await browser.newContext()).newPage();
  await tab.goto(url);
  await tab.getByRole("heading", { name: "Comptes" }).waitFor();
  await expect.poll(() => tab.evaluate(() => window.location.hash)).toBe("#/accounts");

  const other = await (await browser.newContext()).newPage();
  await other.goto(url);
  await other.getByText("Ce lien de connexion a expiré. Redemande-en un.").waitFor();
});
