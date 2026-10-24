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
  ...threadIdsIn(run.message).map((threadId) => ({ replyInThread: { threadId, text: "Noted." } })),
  { type: "result" as const, summary: "Looked" },
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

it("comments a whole artboard from its name strip, shows the chip, opens the tab from it, and clears the chip once resolved", async () => {
  const page = await seam.createPage({
    "home.html": "<!doctype html><h1>Plain title</h1>",
    "manifest.json": JSON.stringify({ artboards: [{ file: "home.html", x: 0, y: 0, width: 400, height: 300 }, { file: "pay.html", x: 600, y: 0, width: 400, height: 300 }] }),
    "pay.html": "<!doctype html><h1>Pay</h1>",
  });
  const tab = await browser.newPage({ viewport: { width: 1440, height: 900 } });
  await tab.goto(`${seam.server.url}/#/pages/${page.id}`);
  await expect.poll(() => tab.frameLocator("iframe").first().locator("h1").textContent()).toBe("Plain title");
  expect(await tab.getByRole("button", { name: "Commenter tout home.html" }).count()).toBe(1);
  expect(await tab.getByText("fil sur l'artboard").count()).toBe(0);

  // Interactive mode.
  await tab.getByRole("button", { name: "Commenter tout home.html" }).click();
  await expect.poll(() => tab.getByRole("tab", { name: /^Commentaires/ }).getAttribute("aria-selected")).toBe("true");
  expect(await tab.getByText("home.html · Artboard entier").count()).toBe(1);
  await tab.getByRole("textbox").fill("Too busy, keep one call to action");
  await tab.getByRole("button", { name: "Envoyer" }).click();

  await expect.poll(() => tab.getByTestId("reply").allTextContents()).toEqual([expect.stringContaining("Noted.")]);
  expect(await tab.getByText("home.html · Artboard entier").count()).toBe(1);
  expect(await tab.locator("[data-pin]").count()).toBe(0);
  expect(await tab.getByText("1 fil sur l'artboard").count()).toBe(1);
  expect(await tab.getByText("fil sur l'artboard").count()).toBe(1);

  // The chip opens the Commentaires tab.
  await tab.getByRole("tab", { name: /^Conversation/ }).click();
  await tab.getByRole("button", { name: "1 fil sur l'artboard" }).click();
  await expect.poll(() => tab.getByRole("tab", { name: /^Commentaires/ }).getAttribute("aria-selected")).toBe("true");

  // Comment mode too, and a second thread makes the count 2.
  await tab.keyboard.press("c");
  await tab.getByRole("button", { name: "Commenter tout home.html" }).click();
  await tab.getByRole("textbox").fill("Also too long");
  await tab.getByRole("button", { name: "Plus tard" }).click();
  await expect.poll(() => tab.getByText("2 fils sur l'artboard").count()).toBe(1);

  // Resolving every thread of the artboard removes the chip.
  await tab.getByRole("button", { name: "Résoudre" }).click();
  await tab.getByTestId("held-bar").getByRole("button", { name: "Tout envoyer" }).click();
  await expect.poll(() => tab.getByRole("button", { name: "Résoudre" }).count()).toBe(1);
  await tab.getByRole("button", { name: "Résoudre" }).click();
  await expect.poll(() => tab.getByText("fil sur l'artboard").count()).toBe(0);
}, 60_000);
