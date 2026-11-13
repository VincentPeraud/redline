import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { copyBuiltWeb } from "./builtWeb.js";
import { type Browser } from "playwright";
import { launchBrowser } from "./journeyBrowser.js";
import { afterAll, beforeAll, expect, it } from "vitest";
import { FakeEngine, startSeam2, type Seam2 } from "@redline/agent/seam2";
import type { AgentTokenResponse } from "@redline/shared";

let browser: Browser;
let webDir: string;
let seam: Seam2;

beforeAll(async () => {
  webDir = mkdtempSync(join(tmpdir(), "redline-web-"));
  copyBuiltWeb(webDir);
  seam = await startSeam2(new FakeEngine(() => []), { webDir });
  browser = await launchBrowser();
}, 60_000);

afterAll(async () => {
  await browser?.close();
  await seam?.stop();
  rmSync(webDir, { recursive: true, force: true });
});

const MANIFEST = JSON.stringify({
  artboards: [
    { file: "list.html", title: "List", x: 0, y: 0, width: 1200, height: 800, frame: "browser" },
    { file: "empty.html", title: "Empty", x: 1300, y: 0, width: 1200, height: 800, frame: "browser" },
  ],
});

it("lists the steps of a review over two pages grouped by page, and jumps to a step of the second page", async () => {
  const home = await seam.createPage({ "list.html": "<!doctype html><h1>List screen</h1>", "empty.html": "<!doctype html><h1>Empty screen</h1>", "manifest.json": MANIFEST }, "Home");
  const settings = await seam.createPage({ "settings.html": "<!doctype html><h1>Settings screen</h1>" }, "Settings");
  const { token } = (await (await seam.server.get("/api/agent-token")).json()) as AgentTokenResponse;
  const declare = async (label: string | undefined, steps: { pageId: string; artboard: string }[]) =>
    ((await (
      await fetch(`${seam.server.url}/agent-api/terminal-sessions/7d6f3f6e-0000-4000-8000-000000000002/reviews`, {
        method: "POST",
        headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
        body: JSON.stringify({ folder: "/work/site", ...(label ? { label } : {}), steps: steps.map((s) => ({ ...s, changed: `${s.artboard} changed`, lookAt: "Look", question: "Fine?" })) }),
      })
    ).json()) as { id: string }).id;
  await declare(undefined, [{ pageId: settings.id, artboard: "settings.html" }]);
  const reviewId = await declare("Agora mock-ups", [
    { pageId: home.id, artboard: "empty.html" },
    { pageId: home.id, artboard: "list.html" },
  ]);
  const tab = await browser.newPage({ viewport: { width: 1440, height: 900 } });

  await tab.goto(`${seam.server.url}/#/reviews/${reviewId}`);

  await expect.poll(() => tab.getByTestId("review-title").textContent()).toContain("Agora mock-ups");
  await tab.getByRole("button", { name: /^Étape 1 \/ 3/ }).click();
  const menu = tab.getByRole("menu", { name: "Étapes de la revue" });
  expect(await menu.locator("h4").allTextContents()).toEqual(["Home", "Settings"]);
  expect(await menu.getByRole("menuitem").allTextContents()).toEqual([
    expect.stringContaining("Home · List"),
    expect.stringContaining("Home · Empty"),
    expect.stringContaining("Settings · settings.html"),
  ]);

  await menu.getByRole("menuitem", { name: /Settings/ }).click();

  await expect.poll(() => tab.getByRole("button", { name: /^Étape \d+ \/ \d+/ }).textContent()).toContain("Étape 3 / 3");
  await tab.close();
}, 60_000);
