import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { copyBuiltWeb } from "./builtWeb.js";
import { type Browser, type Page } from "playwright";
import { launchBrowser } from "./journeyBrowser.js";
import { afterAll, beforeAll, expect, it } from "vitest";
import { FakeEngine, startSeam2, type Seam2 } from "@redline/agent/seam2";
import type { AgentTokenResponse, ChangeReview } from "@redline/shared";

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

/** A review of two artboards of one page, declared as a terminal session does. */
async function declareReview(): Promise<string> {
  const page = await seam.createPage({ "list.html": "<!doctype html><h1>List screen</h1>", "empty.html": "<!doctype html><h1>Empty screen</h1>", "manifest.json": MANIFEST }, "Home");
  const { token } = (await (await seam.server.get("/api/agent-token")).json()) as AgentTokenResponse;
  const step = (artboard: string, question: string) => ({ pageId: page.id, artboard, changed: `The ${artboard} changed`, lookAt: `Look at ${artboard}`, question });
  await fetch(`${seam.server.url}/agent-api/terminal-sessions/7d6f3f6e-0000-4000-8000-000000000001/heartbeat`, { method: "POST", headers: { authorization: `Bearer ${token}`, "content-type": "application/json" }, body: JSON.stringify({ folder: "/work/site", machine: "Mac" }) });
  const response = await fetch(`${seam.server.url}/agent-api/terminal-sessions/7d6f3f6e-0000-4000-8000-000000000001/reviews`, {
    method: "POST",
    headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
    body: JSON.stringify({ folder: `/work/${page.id}/site`, steps: [step("list.html", "Is the list fine?"), step("empty.html", "Is the empty state fine?")] }),
  });
  return ((await response.json()) as { id: string }).id;
}

const counter = (tab: Page) => tab.getByRole("button", { name: /^Étape \d+ \/ \d+/ });

it("moves between steps with the arrow keys, also from inside the artboard, and opens the artboard in a new tab", async () => {
  const reviewId = await declareReview();
  const tab = await browser.newPage({ viewport: { width: 1440, height: 900 } });
  await tab.goto(`${seam.server.url}/#/reviews/${reviewId}`);
  await expect.poll(() => counter(tab).textContent()).toContain("Étape 1 / 2");

  // Right then left on the page.
  await tab.locator("body").press("ArrowRight");
  await expect.poll(() => counter(tab).textContent()).toContain("Étape 2 / 2");
  await expect.poll(() => tab.frameLocator("iframe").locator("h1").textContent()).toBe("Empty screen");
  await tab.locator("body").press("ArrowLeft");
  await expect.poll(() => counter(tab).textContent()).toContain("Étape 1 / 2");

  // The focus inside the artboard: its bridge relays the arrow.
  await expect.poll(() => tab.frameLocator("iframe").locator("h1").textContent()).toBe("List screen");
  await tab.frameLocator("iframe").locator("h1").click();
  await tab.keyboard.press("ArrowRight");
  await expect.poll(() => counter(tab).textContent()).toContain("Étape 2 / 2");

  // Past the last step: the recap, and left goes back to the last step.
  await tab.locator("body").press("ArrowRight");
  await expect.poll(() => tab.getByRole("button", { name: /^Récapitulatif/ }).count()).toBe(1);
  await tab.locator("body").press("ArrowLeft");
  await expect.poll(() => counter(tab).textContent()).toContain("Étape 2 / 2");

  // Typing a remark keeps the arrows in the field.
  await tab.locator("textarea").first().click();
  await tab.keyboard.press("ArrowLeft");
  await tab.waitForTimeout(200);
  expect(await counter(tab).textContent()).toContain("Étape 2 / 2");

  // The artboard opens in a new tab, on its canvas.
  const link = tab.getByRole("link", { name: "Ouvrir l'artboard dans un nouvel onglet" });
  expect(await link.getAttribute("target")).toBe("_blank");
  expect(await link.getAttribute("href")).toMatch(/^#\/pages\/[^/]+\/artboards\/empty\.html$/);
  const [opened] = await Promise.all([tab.context().waitForEvent("page"), link.click()]);
  await opened.waitForLoadState();
  expect(opened.url()).toContain("/artboards/empty.html");
  await opened.close();
  await tab.close();
});
