import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { build } from "vite";
import { chromium, type Browser } from "playwright";
import { afterAll, beforeAll, expect, it } from "vitest";
import { FakeEngine, startSeam2, type Seam2 } from "@redline/agent/seam2";

const webRoot = fileURLToPath(new URL("..", import.meta.url));

let browser: Browser;
let webDir: string;
let seam: Seam2;

const threadIdsIn = (message: string) => [...message.matchAll(/thread id: ([0-9a-f-]{36})\)/g)].map((m) => m[1]);
const engine = new FakeEngine((run) => [
  { edit: { path: "home.html", content: "<!doctype html><h1>Bolder title</h1><button>Go!</button>" } },
  ...threadIdsIn(run.message).map((threadId, i) => ({ replyInThread: { threadId, text: `Handled ${i + 1}.` } })),
  { type: "result" as const, summary: "Title and button" },
]);

beforeAll(async () => {
  webDir = mkdtempSync(join(tmpdir(), "redline-web-"));
  await build({ root: webRoot, logLevel: "silent", build: { outDir: webDir, emptyOutDir: true } });
  seam = await startSeam2(engine, { webDir });
  browser = await chromium.launch();
}, 60_000);

afterAll(async () => {
  await browser?.close();
  await seam?.stop();
  rmSync(webDir, { recursive: true, force: true });
});

it("holds two comments with Plus tard, keeps them over a reload, then sends them together with Tout envoyer", async () => {
  const page = await seam.createPage({ "home.html": "<!doctype html><h1>Plain title</h1><button>Go</button>" });
  const tab = await browser.newPage({ viewport: { width: 1400, height: 900 } });
  await tab.goto(`${seam.server.url}/#/pages/${page.id}`);
  const artboard = tab.frameLocator("iframe");
  await expect.poll(() => artboard.locator("h1").textContent()).toBe("Plain title");

  await tab.keyboard.press("c");
  await artboard.locator("h1").click();
  await tab.locator("#new-comment").fill("Make the title bolder");
  await tab.locator("#new-comment").press("Meta+Enter");
  await artboard.locator("button").click();
  await tab.locator("#new-comment").fill("Exclaim the button");
  await tab.getByRole("button", { name: "Plus tard" }).click();

  await expect.poll(() => tab.getByTestId("held-thread").count()).toBe(2);
  await expect.poll(() => tab.getByTestId("held-bar").textContent()).toContain("2 en attente d'envoi");
  expect(engine.runs).toHaveLength(0);

  await tab.reload();
  await tab.getByRole("tab", { name: /^Commentaires/ }).click();
  await expect.poll(() => tab.getByTestId("held-thread").count()).toBe(2);

  await tab.getByRole("button", { name: "Tout envoyer" }).click();
  await expect.poll(() => tab.getByTestId("reply").allTextContents()).toEqual([
    expect.stringContaining("Handled 1."),
    expect.stringContaining("Handled 2."),
  ]);
  await expect.poll(() => artboard.locator("h1").textContent()).toBe("Bolder title");
  expect(engine.runs).toHaveLength(1);
  expect((await seam.versions(page.id)).map((v) => v.origin)).toEqual(["thread", "creation"]);
  expect(await tab.getByTestId("held-bar").count()).toBe(0);
}, 60_000);
