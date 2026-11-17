import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { copyBuiltWeb } from "./builtWeb.js";
import { type Browser, type Page as Tab } from "playwright";
import { launchBrowser } from "./journeyBrowser.js";
import { afterAll, afterEach, beforeAll, expect, it } from "vitest";
import { FakeEngine, startSeam2, type Seam2 } from "@redline/agent/seam2";

let browser: Browser;
let webDir: string;
let seam: Seam2 | undefined;
let openTab: Tab | undefined;

const FILES = { "home.html": "<!doctype html><h1>Home</h1>" };

beforeAll(async () => {
  webDir = mkdtempSync(join(tmpdir(), "redline-web-"));
  copyBuiltWeb(webDir);
  browser = await launchBrowser();
}, 60_000);

afterEach(async () => {
  await openTab?.close();
  openTab = undefined;
  await seam?.stop();
  seam = undefined;
});

afterAll(async () => {
  await browser?.close();
  rmSync(webDir, { recursive: true, force: true });
});

async function page(viewport: { width: number; height: number }): Promise<Tab> {
  seam = await startSeam2(new FakeEngine(() => [{ type: "result" as const, summary: "Agent run" }]), { webDir });
  const created = await seam.createPage(FILES, "Partager", "conversation");
  await seam.pinThread(created.id, "home.html", "Make the title blue");
  await seam.pinThread(created.id, "home.html", "Bigger button");
  const tab = await browser.newPage({ viewport });
  openTab = tab;
  await tab.goto(`${seam.server.url}/#/pages/${created.id}`);
  return tab;
}

const sheet = (tab: Tab) => tab.getByRole("dialog", { name: "Commentaires" });

it("opens the comments panel as a full-screen sheet from the canvas, acts in it, and closes it with the cross", async () => {
  const tab = await page({ width: 390, height: 844 });
  const opener = tab.getByTestId("comments-opener");
  await expect.poll(() => opener.isVisible()).toBe(true);
  expect(await sheet(tab).isVisible()).toBe(false);
  expect((await opener.boundingBox())!.height).toBeGreaterThanOrEqual(44);
  expect(await opener.textContent()).toContain("Commentaires");

  await opener.click();
  await expect.poll(() => sheet(tab).isVisible()).toBe(true);
  // The sheet covers the whole screen.
  await expect.poll(async () => (await sheet(tab).boundingBox())!.y).toBe(0);
  const box = (await sheet(tab).boundingBox())!;
  expect([box.x, box.width, box.height]).toEqual([0, 390, 844]);
  await expect.poll(() => sheet(tab).getByRole("heading", { name: "Commentaires · 2" }).isVisible()).toBe(true);
  const close = sheet(tab).getByRole("button", { name: "Fermer" });
  const closeBox = (await close.boundingBox())!;
  expect(closeBox.width).toBeGreaterThanOrEqual(44);
  expect(closeBox.height).toBeGreaterThanOrEqual(44);
  expect(await sheet(tab).getByTestId("comment-mode-phone").isVisible()).toBe(true);
  expect(await tab.locator("[data-thread]").count()).toBe(2);

  // An action inside the sheet: the toggle's explanation opens over it.
  await sheet(tab).getByRole("button", { name: /Qui traite les commentaires/ }).click();
  await expect.poll(() => tab.getByRole("dialog", { name: "Qui traite les commentaires" }).count()).toBe(1);
  await tab.keyboard.press("Escape");

  await close.click();
  await expect.poll(() => sheet(tab).isVisible()).toBe(false);
  expect(await opener.isVisible()).toBe(true);

  // Open again: a click on a card takes the canvas to its pin, and the sheet closes to show it.
  await opener.click();
  await expect.poll(() => sheet(tab).isVisible()).toBe(true);
  await tab.locator("[data-thread]").first().click({ position: { x: 20, y: 10 } });
  await expect.poll(() => sheet(tab).isVisible()).toBe(false);
}, 60_000);

it("keeps the desktop side panel: no opener, no cross, tabs in place", async () => {
  const tab = await page({ width: 1440, height: 900 });
  await tab.getByRole("tab", { name: /^Commentaires/ }).click();
  expect(await tab.getByTestId("comments-opener").isVisible()).toBe(false);
  expect(await tab.getByRole("button", { name: "Fermer" }).count()).toBe(0);
  const aside = (await tab.getByRole("complementary", { name: "Commentaires" }).boundingBox())!;
  expect(aside.width).toBe(380);
}, 60_000);
