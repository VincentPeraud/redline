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
const engine = new FakeEngine([
  { type: "usage", model: "opus", inputTokens: 100_000, cacheTokens: 50_000, outputTokens: 10_000 },
  { type: "result", summary: "Added the error screen" },
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

it("creates a conversation, talks to Claude with model and effort, shows the session line, then archives it", async () => {
  const page = await seam.createPage({ "home.html": "<!doctype html><h1>Title</h1>" });
  const tab = await browser.newPage({ viewport: { width: 1400, height: 900 } });
  await tab.goto(`${seam.server.url}/#/pages/${page.id}`);
  const panel = tab.getByTestId("conversations");

  await panel.getByRole("button", { name: "+ Nouvelle" }).click();
  await panel.getByLabel("Modèle").selectOption("opus");
  await panel.getByRole("radio", { name: "high", exact: true }).click();
  await panel.getByLabel("Message à Claude").fill("Add an error screen");
  await panel.getByLabel("Message à Claude").press("Enter");

  await engine.finished(1);
  await expect.poll(() => panel.getByTestId("conversation-message").allTextContents()).toEqual([
    "Add an error screen",
    "Claude — Added the error screen",
  ]);
  expect(engine.runs[0].message).toContain(page.id);
  await expect.poll(() => panel.getByTestId("conversation-session").textContent()).toBe("opus · high · 80 %");
  expect(await panel.getByTestId("conversation-session").evaluate((el) => getComputedStyle(el).color)).toBe("rgb(194, 65, 12)");

  await panel.getByRole("button", { name: "Supprimer cette conversation" }).click();
  await expect.poll(() => panel.getByRole("button", { name: "Conversation", exact: true }).textContent()).toContain("Aucune conversation");
}, 60_000);

it("types and sends on a page without conversation: the first message creates it with the chosen model and effort", async () => {
  const before = engine.runs.length;
  const page = await seam.createPage({ "home.html": "<!doctype html><h1>Title</h1>" });
  const tab = await browser.newPage({ viewport: { width: 1400, height: 900 } });
  await tab.goto(`${seam.server.url}/#/pages/${page.id}`);
  const panel = tab.getByTestId("conversations");

  await panel.getByText("Nouvelle conversation", { exact: true }).waitFor();
  await panel.getByText("Écris ton premier message : la conversation est créée à l'envoi.").waitFor();
  expect(await panel.getByLabel("Message à Claude").isEnabled()).toBe(true);
  await panel.getByLabel("Modèle").selectOption("opus");
  await panel.getByRole("radio", { name: "low", exact: true }).click();
  await panel.getByLabel("Message à Claude").fill("First words");
  await panel.getByRole("button", { name: "Envoyer" }).click();

  await engine.finished(before + 1);
  await expect.poll(() => panel.getByTestId("conversation-message").first().textContent()).toBe("First words");
  await expect.poll(() => panel.getByTestId("conversation-session").textContent()).toContain("opus · low");
  expect(engine.runs[before].message).toContain(page.id);

  await panel.getByRole("button", { name: "+ Nouvelle" }).click();
  await expect.poll(() => panel.getByRole("button", { name: "Conversation", exact: true }).textContent()).toContain("Nouvelle conversation");
  await expect.poll(() => panel.getByTestId("conversation-message").count()).toBe(0);
}, 60_000);
