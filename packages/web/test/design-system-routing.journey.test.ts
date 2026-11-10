import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { build } from "vite";
import { type Browser } from "playwright";
import { launchBrowser } from "./journeyBrowser.js";
import { afterAll, beforeAll, expect, it } from "vitest";
import { CORE_TOKENS, type DesignSystem, type Project, type WorkItem } from "@redline/shared";
import { startTestServer, type TestAgent, type TestServer } from "@redline/server/test-harness";

const webRoot = fileURLToPath(new URL("..", import.meta.url));

let server: TestServer;
let browser: Browser;
let webDir: string;

beforeAll(async () => {
  webDir = mkdtempSync(join(tmpdir(), "redline-web-"));
  await build({ root: webRoot, logLevel: "silent", build: { outDir: webDir, emptyOutDir: true } });
  server = await startTestServer({ webDir });
  browser = await launchBrowser();
}, 60_000);

afterAll(async () => {
  await browser?.close();
  await server?.stop();
  rmSync(webDir, { recursive: true, force: true });
});

const tokensCss = `:root {\n${CORE_TOKENS.map((t) => `  ${t}: #f25c2a;`).join("\n")}\n}\n`;
const received = (agent: TestAgent): WorkItem[] => agent.messages.flatMap((m) => (m.type === "work" ? [m.item] : []));

it("runs a design system conversation on the agent of the project it was opened from", async () => {
  const ds = (await (await server.post("/api/design-systems", {
    title: "Lumora",
    files: { "tokens.css": tokensCss, "manifest.json": JSON.stringify({ artboards: [{ file: "index.html", x: 0, y: 0, width: 400, height: 300 }] }), "index.html": "<!doctype html><h1>Tokens</h1>" },
  })).json()) as DesignSystem;
  const front = (await (await server.post("/api/projects", { title: "Front", designSystem: ds.id })).json()) as Project;
  const blog = (await (await server.post("/api/projects", { title: "Blog", designSystem: ds.id })).json()) as Project;
  const frontAgent = await server.connectAgent({ machine: "Mac", folder: "/work/front", projectId: front.id });
  const blogAgent = await server.connectAgent({ machine: "Mac", folder: "/work/blog", projectId: blog.id });
  await Promise.all([frontAgent.hello, blogAgent.hello]);

  const tab = await browser.newPage({ viewport: { width: 1440, height: 900 } });
  await tab.goto(`${server.url}/#/projects/${blog.id}/design-system`);
  await tab.getByRole("link", { name: "ouvrir Lumora" }).click();
  await tab.getByTestId("ds-page").first().click();
  await expect.poll(() => new URL(tab.url()).hash).toContain(`projet=${blog.id}`);

  const panel = tab.getByTestId("conversations");
  await panel.getByRole("button", { name: "+ Nouvelle" }).click();
  await panel.getByLabel("Message à Claude").fill("Add a danger colour");
  await panel.getByLabel("Message à Claude").press("Enter");

  await expect.poll(() => received(blogAgent).length).toBe(1);
  expect(received(frontAgent)).toHaveLength(0);

  blogAgent.send({ type: "work-done", workId: received(blogAgent)[0].id });

  // Opened again from the Design systems list, in the same tab: no project of origin, the oldest project's agent runs it.
  await tab.goto(`${server.url}/#/design-systems/${ds.id}`);
  await tab.getByTestId("ds-page").first().click();
  await panel.getByRole("button", { name: "+ Nouvelle" }).click();
  await panel.getByLabel("Message à Claude").fill("Add a success colour");
  await panel.getByLabel("Message à Claude").press("Enter");
  await expect.poll(() => received(frontAgent).length).toBe(1);
  expect(received(blogAgent)).toHaveLength(1);
  await tab.close();
}, 60_000);
