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
const usage = (cacheTokens: number) => ({ type: "usage" as const, model: "sonnet-x", inputTokens: 0, cacheTokens, outputTokens: 0 });
const engine = new FakeEngine((run) =>
  run.message.includes("Write a summary")
    ? [{ type: "result", summary: "Summary of the session" }]
    : [usage(20_000), usage(150_000), { type: "result", summary: "ok" }],
);

beforeAll(async () => {
  webDir = mkdtempSync(join(tmpdir(), "redline-web-"));
  copyBuiltWeb(webDir);
  seam = await startSeam2(engine, { webDir, agent: { effort: "low" } });
  browser = await launchBrowser();
}, 60_000);

afterAll(async () => {
  await browser?.close();
  await seam?.stop();
  rmSync(webDir, { recursive: true, force: true });
});

it("shows model, effort and context %, turns orange from 70 % and starts a new session from a summary", async () => {
  const page = await seam.createPage({ "home.html": "<!doctype html><h1>Title</h1>" });
  await seam.pinThread(page.id, "home.html", "Look at this");
  await seam.waitForWorkEnd(1);

  const tab = await browser.newPage({ viewport: { width: 1400, height: 900 } });
  await tab.goto(`${seam.server.url}/#/pages/${page.id}`);
  await tab.getByRole("tab", { name: /^Commentaires/ }).click();
  const context = tab.getByTestId("context");
  await expect.poll(() => context.textContent()).toContain("sonnet-x · low · 75 %");
  expect(await context.getAttribute("data-warn")).toBe("true");

  await tab.getByRole("button", { name: "Nouvelle session" }).click();
  await expect.poll(() => context.textContent()).toContain("Nouvelle session prête");
  expect(await tab.getByRole("button", { name: "Nouvelle session" }).count()).toBe(0);

  await tab.getByRole("button", { name: "Répondre" }).click();
  await tab.getByLabel("Répondre").fill("Continue");
  await tab.getByRole("button", { name: "Envoyer la réponse" }).click();
  await engine.finished(3);
  expect(engine.runs[2].resume).toBe(false);
  expect(engine.runs[2].message).toContain("Summary of the session");
}, 60_000);
