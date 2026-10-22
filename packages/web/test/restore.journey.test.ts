import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { build } from "vite";
import { chromium, type Browser } from "playwright";
import { afterAll, beforeAll, expect, it } from "vitest";
import type { Page } from "@redline/shared";
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

it("restores an earlier version and the artboard changes back", async () => {
  const project = (await (await server.post("/api/projects", { title: "Acme" })).json()) as { id: string };
  const page = (await (
    await server.post(`/api/projects/${project.id}/pages`, {
      title: "Landing",
      type: "prototype",
      files: { "home.html": "<!doctype html><h1>Version one</h1>" },
    })
  ).json()) as Page;
  await server.post(`/api/pages/${page.id}/versions`, {
    files: { "home.html": "<!doctype html><h1>Version two</h1>" },
    message: "Second title",
    origin: "thread",
  });

  const tab = await browser.newPage();
  await tab.goto(server.url);
  const artboard = tab.frameLocator("iframe");
  await expect.poll(() => artboard.locator("h1").textContent()).toBe("Version two");

  await tab.getByRole("button", { name: "History" }).click();
  const items = tab.getByRole("list", { name: "Versions of Landing" }).getByRole("listitem");
  await expect.poll(() => items.count()).toBe(2);
  await expect(items.first().textContent()).resolves.toContain("Second title");

  await items.nth(1).getByRole("button", { name: "Restore" }).click();

  await expect.poll(() => artboard.locator("h1").textContent()).toBe("Version one");
  await expect.poll(() => items.count()).toBe(3);
  await expect(items.first().textContent()).resolves.toContain("restore");
}, 60_000);
