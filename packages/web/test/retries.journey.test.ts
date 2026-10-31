import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { build } from "vite";
import { type Browser } from "playwright";
import { launchBrowser } from "./journeyBrowser.js";
import { afterAll, beforeAll, expect, it } from "vitest";
import { FakeEngine, startSeam2, type Seam2 } from "@redline/agent/seam2";

const webRoot = fileURLToPath(new URL("..", import.meta.url));

let browser: Browser;
let webDir: string;
let seam: Seam2;
let failing = true;

beforeAll(async () => {
  webDir = mkdtempSync(join(tmpdir(), "redline-web-"));
  await build({ root: webRoot, logLevel: "silent", build: { outDir: webDir, emptyOutDir: true } });
  const engine = new FakeEngine(() => (failing ? [{ type: "error", message: "Crashed" }] : [{ type: "result", summary: "Fixed" }]));
  seam = await startSeam2(engine, { webDir, retryDelaysMs: [] });
  browser = await launchBrowser();
}, 60_000);

afterAll(async () => {
  await browser?.close();
  await seam?.stop();
  rmSync(webDir, { recursive: true, force: true });
});

it("shows 'Échec' with nothing published, and 'Relancer' runs it again", async () => {
  const page = await seam.createPage({ "home.html": "<!doctype html><h1>Title</h1>" });
  await seam.pinThread(page.id, "home.html", "Change the title");

  const tab = await browser.newPage({ viewport: { width: 1400, height: 900 } });
  await tab.goto(`${seam.server.url}/#/pages/${page.id}`);
  await tab.getByRole("tab", { name: /^Commentaires/ }).click();
  await expect.poll(() => tab.getByTestId("run-status").textContent()).toContain("Échec");
  expect(await tab.getByTestId("run-failed").textContent()).toContain("Rien n'a été publié");
  expect(await seam.versions(page.id)).toHaveLength(1);

  failing = false;
  await tab.getByRole("button", { name: "Relancer" }).click();
  await tab.getByRole("tab", { name: /^Commentaires/ }).click();
  await expect.poll(() => tab.getByTestId("run-status").getAttribute("data-status")).toBe("answered");
}, 60_000);
