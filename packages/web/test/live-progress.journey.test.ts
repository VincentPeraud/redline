import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { build } from "vite";
import { type Browser } from "playwright";
import { launchBrowser } from "./journeyBrowser.js";
import { afterAll, beforeAll, expect, it } from "vitest";
import { startSeam2, type Seam2 } from "@redline/agent/seam2";
import type { Engine } from "../../agent/src/engine.js";

const webRoot = fileURLToPath(new URL("..", import.meta.url));

let browser: Browser;
let webDir: string;
let seam: Seam2;
let release!: () => void;
const gate = new Promise<void>((resolve) => (release = resolve));

const stream = async function* () {
  yield { type: "step" as const, tool: "Read", summary: "home.html" };
  yield { type: "text" as const, text: "Checking the title." };
  await gate;
  yield { type: "step" as const, tool: "Edit", summary: "home.html" };
  yield { type: "result" as const, summary: "Nothing to change" };
};
const engine: Engine = { start: stream, resume: stream };

beforeAll(async () => {
  webDir = mkdtempSync(join(tmpdir(), "redline-web-"));
  await build({ root: webRoot, logLevel: "silent", build: { outDir: webDir, emptyOutDir: true } });
  seam = await startSeam2(engine, { webDir });
  browser = await launchBrowser();
}, 60_000);

afterAll(async () => {
  release();
  await browser?.close();
  await seam?.stop();
  rmSync(webDir, { recursive: true, force: true });
});

it("shows status, steps and streamed text as a run goes, and still shows them after a reload mid-run", async () => {
  const page = await seam.createPage({ "home.html": "<!doctype html><h1>Plain title</h1>" });
  const tab = await browser.newPage({ viewport: { width: 1400, height: 900 } });
  await tab.goto(`${seam.server.url}/#/pages/${page.id}`);
  const artboard = tab.frameLocator("iframe");
  await expect.poll(() => artboard.locator("h1").textContent()).toBe("Plain title");

  await tab.keyboard.press("c");
  await artboard.locator("h1").click();
  await tab.locator("#new-comment").fill("Check the title");
  await tab.locator("#new-comment").press("Enter");

  await expect.poll(() => tab.getByTestId("run-status").getAttribute("data-status")).toBe("running");
  await expect.poll(() => tab.getByTestId("run-steps").textContent()).toContain("Lit");

  await tab.reload();
  await tab.getByRole("tab", { name: /^Commentaires/ }).click();
  await expect.poll(() => tab.getByTestId("run-steps").textContent()).toContain("Lit");
  expect(await tab.getByText("Checking the title.").count()).toBe(0);

  release();
  await expect.poll(() => tab.getByTestId("run-status").getAttribute("data-status")).toBe("answered");
}, 60_000);
