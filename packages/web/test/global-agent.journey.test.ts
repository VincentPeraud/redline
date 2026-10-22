import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { build } from "vite";
import { chromium, type Browser } from "playwright";
import { afterAll, beforeAll, expect, it } from "vitest";
import type { Project } from "@redline/shared";
import { startTestServer, type TestServer } from "@redline/server/test-harness";

const webRoot = fileURLToPath(new URL("..", import.meta.url));

let server: TestServer;
let browser: Browser;
let webDir: string;

beforeAll(async () => {
  webDir = mkdtempSync(join(tmpdir(), "redline-web-"));
  await build({ root: webRoot, logLevel: "silent", build: { outDir: webDir, emptyOutDir: true } });
  server = await startTestServer({ webDir });
  browser = await chromium.launch();
}, 60_000);

afterAll(async () => {
  await browser?.close();
  await server?.stop();
  rmSync(webDir, { recursive: true, force: true });
});

it("shows which agent serves a project in the top bar, including the global agent taking over once allowed", async () => {
  const project = (await (await server.post("/api/projects", { title: "Acme" })).json()) as Project;
  const tab = await browser.newPage();
  await tab.goto(`${server.url}/#/projects/${project.id}`);
  const pill = tab.getByTestId("agent-pill");
  await expect.poll(() => pill.textContent()).toBe("Aucun agent connecté");

  const projectAgent = await server.connectAgent({ machine: "MacBook", folder: "/work/acme", projectId: project.id });
  await projectAgent.hello;
  await tab.reload();
  await expect.poll(() => pill.textContent()).toBe("Agent acme connecté");

  const global = await server.connectAgent({ machine: "iMac", folder: "/home/neutral", kind: "global" });
  await global.hello;
  projectAgent.close();
  await projectAgent.closed;

  await tab.reload();
  await expect.poll(() => pill.textContent()).toBe("Aucun agent connecté");

  await fetch(`${server.url}/api/projects/${project.id}`, { method: "PATCH", headers: { "content-type": "application/json" }, body: JSON.stringify({ globalTakeoverOverride: true }) });
  await tab.reload();
  await expect.poll(() => pill.textContent()).toBe("Agent global iMac connecté");
}, 60_000);
