import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { copyBuiltWeb } from "./builtWeb.js";
import { type Browser, type Locator, type Page } from "playwright";
import { launchBrowser } from "./journeyBrowser.js";
import { afterAll, beforeAll, expect, it } from "vitest";
import { FakeEngine, startSeam2, type Seam2 } from "@redline/agent/seam2";
import type { AgentTokenResponse, ChangeReview } from "@redline/shared";

let browser: Browser;
let webDir: string;
let seam: Seam2;
let sessionNumber = 0;

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
    { file: "detail.html", title: "Detail", x: 2600, y: 0, width: 1200, height: 800, frame: "browser" },
  ],
});

async function declareReview(): Promise<string> {
  const page = await seam.createPage(
    { "list.html": "<!doctype html><h1>List screen</h1>", "empty.html": "<!doctype html><h1>Empty screen</h1>", "detail.html": "<!doctype html><h1>Detail screen</h1>", "manifest.json": MANIFEST },
    "Home",
  );
  const { token } = (await (await seam.server.get("/api/agent-token")).json()) as AgentTokenResponse;
  const sessionId = `7d6f3f6e-0000-4000-8000-00000000012${sessionNumber++}`;
  const step = (artboard: string) => ({ pageId: page.id, artboard, changed: `The ${artboard} changed`, lookAt: `Look at ${artboard}`, question: `Is ${artboard} fine?` });
  await fetch(`${seam.server.url}/agent-api/terminal-sessions/${sessionId}/heartbeat`, { method: "POST", headers: { authorization: `Bearer ${token}`, "content-type": "application/json" }, body: JSON.stringify({ folder: "/work/site", machine: "Mac" }) });
  const response = await fetch(`${seam.server.url}/agent-api/terminal-sessions/${sessionId}/reviews`, {
    method: "POST",
    headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
    body: JSON.stringify({ folder: `/work/${page.id}/site`, steps: [step("list.html"), step("empty.html"), step("detail.html")] }),
  });
  return ((await response.json()) as { id: string }).id;
}

const api = (reviewId: string, path = "") => `${seam.server.url}/api/change-reviews/${reviewId}${path}`;
const reviewOf = async (reviewId: string) => (await (await fetch(api(reviewId))).json()) as ChangeReview;
const open = async (reviewId: string, hash: string): Promise<Page> => {
  const tab = await browser.newPage({ viewport: { width: 390, height: 844 }, hasTouch: true });
  await tab.goto(`${seam.server.url}/#/reviews/${reviewId}${hash}`);
  return tab;
};
const height = async (locator: Locator) => (await locator.boundingBox())!.height;

it("shows the red bar and the sheet of a step, with 44 px targets and the details folded", async () => {
  const reviewId = await declareReview();
  const tab = await open(reviewId, "/steps/1");

  const sheet = tab.getByRole("region", { name: "Question de l'étape" });
  await sheet.getByText("Is list.html fine?").waitFor();
  expect(await tab.getByTestId("review-title").count()).toBe(0);
  await expect(sheet.getByText("Home · List").first().isVisible()).resolves.toBe(true);
  await expect(sheet.getByText("Non vu").isVisible()).resolves.toBe(true);
  await expect(sheet.getByText("The list.html changed").isVisible()).resolves.toBe(false);

  for (const button of [tab.getByRole("button", { name: "Retour au canvas" }), tab.getByRole("button", { name: /^1 \/ 3/ }), sheet.getByRole("button", { name: "Remarque" }), sheet.getByRole("button", { name: "OK" }), sheet.getByRole("button", { name: "Ce qui a changé et quoi regarder" })]) {
    expect(await height(button)).toBeGreaterThanOrEqual(44);
  }
  const bar = (await tab.getByTestId("review-top").boundingBox())!;
  expect(bar.width).toBe(390);
  expect(await tab.locator("body").evaluate((body) => body.scrollWidth)).toBeLessThanOrEqual(390);

  await sheet.getByRole("button", { name: "Ce qui a changé et quoi regarder" }).click();
  await sheet.getByText("The list.html changed").waitFor();
  await sheet.getByText("Look at list.html").waitFor();
  await tab.close();
}, 60_000);

it("saves a remark from the sheet with Enregistrée, Effacer and Fermer", async () => {
  const reviewId = await declareReview();
  const tab = await open(reviewId, "/steps/1");
  const sheet = tab.getByRole("region", { name: "Question de l'étape" });

  await sheet.getByRole("button", { name: "Remarque" }).click();
  const field = sheet.getByRole("textbox");
  await expect.poll(() => field.evaluate((node) => node === document.activeElement)).toBe(true);
  await field.fill("Put the decisions first");
  await sheet.getByText("Enregistrée").waitFor();
  expect((await reviewOf(reviewId)).steps[0]!.answers.map((answer) => answer.text)).toEqual(["Put the decisions first"]);
  expect(await height(sheet.getByRole("button", { name: "Effacer" }))).toBeGreaterThanOrEqual(44);
  expect(await height(sheet.getByRole("button", { name: "Fermer" }))).toBeGreaterThanOrEqual(44);
  await expect(tab.locator("iframe").first().isVisible()).resolves.toBe(false);

  await sheet.getByRole("button", { name: "Fermer" }).click();
  await sheet.getByRole("button", { name: "Remarque" }).waitFor();
  await expect(sheet.getByRole("textbox").count()).resolves.toBe(0);

  await sheet.getByRole("button", { name: "Remarque" }).click();
  await sheet.getByRole("button", { name: "Effacer" }).click();
  await expect.poll(async () => (await reviewOf(reviewId)).steps[0]!.answers.length, { timeout: 10_000 }).toBe(0);
  await tab.close();
}, 60_000);

it("validates from the sheet, then shows ✓ OK with Validé · annuler and Étape suivante", async () => {
  const reviewId = await declareReview();
  const tab = await open(reviewId, "/steps/1");
  const sheet = tab.getByRole("region", { name: "Question de l'étape" });

  await sheet.getByRole("button", { name: "OK" }).click();
  await expect.poll(async () => (await reviewOf(reviewId)).steps[0]!.answers.map((answer) => answer.kind)).toEqual(["ok"]);
  await sheet.getByText("Is empty.html fine?").waitFor();

  await tab.getByRole("button", { name: /^2 \/ 3/ }).click();
  await tab.getByRole("menuitem", { name: /Home · List/ }).click();
  await sheet.getByText("✓ OK").waitFor();
  expect(await height(sheet.getByRole("button", { name: "Validé · annuler" }))).toBeGreaterThanOrEqual(44);
  await sheet.getByRole("button", { name: "Étape suivante" }).click();
  await sheet.getByText("Is empty.html fine?").waitFor();

  await tab.getByRole("button", { name: /^2 \/ 3/ }).click();
  await tab.getByRole("menuitem", { name: /Home · List/ }).click();
  await sheet.getByRole("button", { name: "Validé · annuler" }).click();
  await expect.poll(async () => (await reviewOf(reviewId)).steps[0]!.answers.length).toBe(0);
  await tab.close();
}, 60_000);

it("finishes the review from the counter menu, which fits the screen", async () => {
  const reviewId = await declareReview();
  const tab = await open(reviewId, "/steps/1");

  await tab.getByRole("button", { name: /^1 \/ 3/ }).click();
  const menu = tab.getByRole("menu", { name: "Étapes de la revue" });
  const box = (await menu.boundingBox())!;
  expect(box.x).toBeGreaterThanOrEqual(0);
  expect(box.x + box.width).toBeLessThanOrEqual(390);
  const finish = menu.getByRole("menuitem", { name: "Terminer la revue" });
  expect(await height(finish)).toBeGreaterThanOrEqual(44);
  expect(await height(menu.getByRole("menuitem", { name: /Home · Empty/ }))).toBeGreaterThanOrEqual(44);
  await finish.click();
  await tab.getByRole("dialog", { name: "3 étapes non vues : terminer quand même ?" }).getByRole("button", { name: "Terminer quand même" }).click();
  await tab.getByRole("heading", { name: "Revue terminée" }).waitFor();
  expect((await reviewOf(reviewId)).state).toBe("finished");
  await tab.close();
}, 60_000);

it("shows the recap in one column that fits a phone", async () => {
  const reviewId = await declareReview();
  const tab = await open(reviewId, "/recap");

  await tab.getByRole("heading", { name: "Avant de terminer" }).waitFor();
  expect(await tab.locator("body").evaluate((body) => body.scrollWidth)).toBeLessThanOrEqual(390);
  const heading = (await tab.getByRole("heading", { name: "Avant de terminer" }).boundingBox())!;
  const list = (await tab.getByText("Non vus (3)").boundingBox())!;
  expect(list.y).toBeGreaterThan(heading.y);
  expect(Math.abs(list.x - heading.x)).toBeLessThan(40);
  expect((await tab.getByRole("button", { name: "Terminer la revue" }).boundingBox())!.height).toBeGreaterThanOrEqual(44);
  await tab.close();
}, 60_000);
