import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { copyBuiltWeb } from "./builtWeb.js";
import { type Browser } from "playwright";
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

const MANIFEST = JSON.stringify({ artboards: [{ file: "list.html", title: "List", x: 0, y: 0, width: 390, height: 800, frame: "browser" }] });
const HTML = `<!doctype html><body style="margin:0"><h1 style="margin:40px 16px">Titre de la liste</h1><p style="margin:16px">Un paragraphe</p></body>`;

async function declareReview(): Promise<string> {
  const page = await seam.createPage({ "list.html": HTML, "manifest.json": MANIFEST }, "Home");
  const { token } = (await (await seam.server.get("/api/agent-token")).json()) as AgentTokenResponse;
  const session = "7d6f3f6e-0000-4000-8000-000000000009";
  await fetch(`${seam.server.url}/agent-api/terminal-sessions/${session}/heartbeat`, { method: "POST", headers: { authorization: `Bearer ${token}`, "content-type": "application/json" }, body: JSON.stringify({ folder: "/work/site", machine: "Mac" }) });
  const response = await fetch(`${seam.server.url}/agent-api/terminal-sessions/${session}/reviews`, {
    method: "POST",
    headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
    body: JSON.stringify({ folder: "/work/site", steps: [{ pageId: page.id, artboard: "list.html", changed: "c", lookAt: "l", question: "Is the list fine?" }] }),
  });
  return ((await response.json()) as { id: string }).id;
}

const reviewOf = async (reviewId: string) => (await (await seam.server.get(`/api/change-reviews/${reviewId}`)).json()) as ChangeReview;

it("pins an element on a phone: Épingler, tap an element, type, Fermer, see it listed", async () => {
  const reviewId = await declareReview();
  const tab = await browser.newPage({ viewport: { width: 390, height: 844 }, hasTouch: true });
  await tab.goto(`${seam.server.url}/#/reviews/${reviewId}/steps/1`);
  const frame = tab.frameLocator("iframe");
  await expect.poll(() => frame.locator("h1").textContent()).toBe("Titre de la liste");
  const sheet = tab.getByRole("region", { name: "Question de l'étape" });

  // No Alt reminder on a phone.
  expect(await tab.getByTestId("review-pin-hint").count()).toBe(0);

  // Pick mode: banner, zones hint, 44 px targets; Annuler leaves it.
  await sheet.getByRole("button", { name: "Épingler" }).tap();
  const banner = tab.getByTestId("review-pick-banner");
  await expect.poll(() => banner.textContent()).toContain("Touche un élément à épingler");
  await expect.poll(() => tab.getByText("Les zones se tracent sur ordinateur.").count()).toBe(1);
  const cancel = banner.getByRole("button", { name: "Annuler" });
  expect((await cancel.boundingBox())!.height).toBeGreaterThanOrEqual(44);
  await cancel.tap();
  await expect.poll(() => tab.getByTestId("review-pick-banner").count()).toBe(0);

  // Tap an element: the text field opens in the sheet, no popover on the stage.
  await sheet.getByRole("button", { name: "Épingler" }).tap();
  await frame.locator("h1").tap();
  const field = tab.getByRole("textbox", { name: "Ton épingle" });
  await expect.poll(() => field.count()).toBe(1);
  await expect.poll(() => tab.evaluate(() => document.activeElement?.getAttribute("aria-label"))).toBe("Ton épingle");
  expect(await tab.getByRole("dialog", { name: "Épingle 1" }).count()).toBe(0);
  await field.fill("Le titre est trop petit");
  await expect.poll(async () => (await reviewOf(reviewId)).steps[0]!.pins.map((pin) => [pin.number, pin.text])).toEqual([[1, "Le titre est trop petit"]]);
  await expect.poll(() => sheet.getByText("Enregistré", { exact: true }).count()).toBe(1);
  await sheet.getByRole("button", { name: "Fermer" }).tap();

  // Back on the list: the pin, its text and Modifier.
  const list = tab.getByTestId("review-pins-list");
  await expect.poll(() => list.textContent()).toContain("Le titre est trop petit");
  const modify = list.getByRole("button", { name: "Modifier" });
  expect((await modify.boundingBox())!.height).toBeGreaterThanOrEqual(44);
  expect(await tab.locator("body").evaluate((body) => body.scrollWidth)).toBeLessThanOrEqual(390);

  // Modifier reopens the text; Effacer removes the pin.
  await modify.tap();
  await expect.poll(() => field.inputValue()).toBe("Le titre est trop petit");
  await sheet.getByRole("button", { name: "Effacer" }).tap();
  await expect.poll(async () => (await reviewOf(reviewId)).steps[0]!.pins.length, { timeout: 10_000 }).toBe(0);
  await tab.close();
}, 60_000);
