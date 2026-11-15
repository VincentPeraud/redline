import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { copyBuiltWeb } from "./builtWeb.js";
import { type Browser } from "playwright";
import { launchBrowser } from "./journeyBrowser.js";
import { afterAll, beforeAll, expect, it } from "vitest";
import { FakeEngine, startSeam2, type Seam2 } from "@redline/agent/seam2";

let browser: Browser;
let webDir: string;
let seam: Seam2;
/** The thread id the server put in the message it sent to Claude. */
const threadIdOf = (message: string) => message.match(/thread id: ([^)]+)\)/)![1];

const engine = new FakeEngine((run) => [
  { type: "step", tool: "Edit", summary: "home.html" },
  { edit: { path: "home.html", content: "<!doctype html><h1>Bolder title</h1>" } },
  { replyInThread: { threadId: threadIdOf(run.message), text: "Made the title bolder." } },
  { type: "result", summary: "Bolder title" },
]);

beforeAll(async () => {
  webDir = mkdtempSync(join(tmpdir(), "redline-web-"));
  copyBuiltWeb(webDir);
  seam = await startSeam2(engine, { webDir });
  browser = await launchBrowser();
}, 60_000);

afterAll(async () => {
  await browser?.close();
  await seam?.stop();
  rmSync(webDir, { recursive: true, force: true });
});

it("pins a comment, then shows Claude's answer in the thread and the reloaded artboard", async () => {
  const page = await seam.createPage({ "home.html": "<!doctype html><h1>Plain title</h1>" });
  const tab = await browser.newPage({ viewport: { width: 1400, height: 900 } });
  await tab.goto(`${seam.server.url}/#/pages/${page.id}`);
  const artboard = tab.frameLocator("iframe");
  await expect.poll(() => artboard.locator("h1").textContent()).toBe("Plain title");

  await tab.keyboard.press("c");
  await artboard.locator("h1").click();
  await tab.locator("#new-comment").fill("Make the title bolder");
  await tab.locator("#new-comment").press("Enter");

  await expect.poll(() => tab.getByTestId("reply").textContent()).toContain("Made the title bolder.");
  await expect.poll(() => artboard.locator("h1").textContent()).toBe("Bolder title");
  expect((await seam.versions(page.id)).map((v) => v.origin)).toEqual(["thread", "creation"]);
}, 60_000);
