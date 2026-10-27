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
  for (const part of ["Fil", "Acme › Onboarding", "Résolu", "redline-agent-folder", "opus · high · 20 %"]) expect(text).toContain(part);
  expect(await rows.filter({ hasText: "Error pages" }).textContent()).toContain("Conversation");
  expect(text).toMatch(/[0-9a-f]{4}…[0-9a-f]{3}/);
  expect(text).toContain("à l'instant");

  await tab.getByRole("button", { name: /^Résolues/ }).click();
  await expect.poll(() => rows.allTextContents().then((all) => all.length)).toBe(1);
  expect(await rows.first().textContent()).toContain("Button too discreet");
  await tab.getByRole("button", { name: /^Répondues/ }).click();
  await expect.poll(() => rows.allTextContents().then((all) => all.length)).toBe(1);
  expect(await rows.first().textContent()).toContain("Error pages");
  await tab.getByRole("button", { name: /^Toutes/ }).click();

  await threadRow.click();
  await expect.poll(() => tab.getByTestId("session-message").allTextContents()).toEqual([
    "ToiButton too discreet",
    "ClaudeButton is now filled.",
  ]);
  expect(tab.url()).toContain("#/sessions");

  // The activity column words the time since the last message relative to now.
  const later = async (ms: number) => {
    const clock = await browser.newPage();
    await clock.clock.setFixedTime(Date.now() + ms);
    await clock.goto(`${seam.server.url}/#/sessions`);
    await expect.poll(() => rows.count()).toBe(2);
    return clock.getByTestId("session-row").filter({ hasText: "Button too discreet" }).textContent();
  };
  expect(await later(5 * 60_000)).toContain("il y a 5 min");
  expect(await later(3 * 3_600_000)).toContain("il y a 3 h");
  expect(await later(30 * 3_600_000)).toContain("hier");
  expect(await later(50 * 3_600_000)).toContain("il y a 2 jours");
}, 60_000);
