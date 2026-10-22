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
const engine = new FakeEngine(async (run) => {
  const threadId = /thread id: ([0-9a-f-]{36})/.exec(run.message)?.[1];
  return [
    { type: "usage", model: "opus", effort: "high", inputTokens: 0, cacheTokens: 40_000, outputTokens: 0 },
    ...(threadId ? [{ replyInThread: { threadId, text: "Button is now filled." } }] : []),
    { type: "result", summary: "Done" },
  ];
});

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

it("lists threads and conversations, filters by status and opens a session's messages without opening the page", async () => {
  const page = await seam.createPage({ "home.html": "<!doctype html><h1>Title</h1>" }, "Onboarding");
  const thread = await seam.pinThread(page.id, "home.html", "Button too discreet");
  await seam.waitForWorkEnd(1);
  const conversation = (await (await seam.server.post(`/api/pages/${page.id}/conversations`, { title: "Error pages" })).json()) as { id: string };
  await seam.server.post(`/api/conversations/${conversation.id}/messages`, { body: "Add error pages" });
  await seam.waitForWorkEnd(2);
  await seam.server.post(`/api/threads/${thread.id}/resolve`, {});

  const tab = await browser.newPage({ viewport: { width: 1500, height: 900 } });
  await tab.goto(`${seam.server.url}/#/sessions`);
  const rows = tab.getByTestId("session-row");
  await expect.poll(() => rows.count()).toBe(2);

  const threadRow = rows.filter({ hasText: "Button too discreet" });
  const text = (await threadRow.textContent())!;
  for (const part of ["Fil", "Acme › Onboarding", "Résolu", "test-machine", "opus · high · 20 %"]) expect(text).toContain(part);
  expect(await rows.filter({ hasText: "Error pages" }).textContent()).toContain("Conversation");

  await tab.getByRole("button", { name: /^Résolues/ }).click();
  await expect.poll(() => rows.allTextContents().then((all) => all.length)).toBe(1);
  expect(await rows.first().textContent()).toContain("Button too discreet");
  await tab.getByRole("button", { name: /^Répondues/ }).click();
  await expect.poll(() => rows.allTextContents().then((all) => all.length)).toBe(1);
  expect(await rows.first().textContent()).toContain("Error pages");
  await tab.getByRole("button", { name: /^Toutes/ }).click();

  await threadRow.click();
  await expect.poll(() => tab.getByTestId("session-message").allTextContents()).toEqual([
    "Toi — Button too discreet",
    "Claude — Button is now filled.",
  ]);
  expect(tab.url()).toContain("#/sessions");
}, 60_000);
