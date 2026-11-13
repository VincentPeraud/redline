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
  const response = await fetch(`${seam.server.url}/agent-api/terminal-sessions/7d6f3f6e-0000-4000-8000-000000000001/reviews`, {
    method: "POST",
    headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
    body: JSON.stringify({ folder: "/work/site", steps: [step("list.html", "Is the list fine?"), step("empty.html", "Is the empty state fine?")] }),
  });
  return ((await response.json()) as { id: string }).id;
}

const counter = (tab: Page) => tab.getByRole("button", { name: /^Étape \d+ \/ \d+/ });

it("goes through the steps with OK, cancels an OK, finishes the review and locks it", async () => {
  const reviewId = await declareReview();
  const tab = await browser.newPage({ viewport: { width: 1440, height: 900 } });
  await tab.goto(`${seam.server.url}/#/reviews/${reviewId}`);

  // The review identity: red bar, REVUE pill, title, counter, progress.
  await expect.poll(() => counter(tab).textContent()).toContain("Étape 1 / 2");
  expect(await tab.getByText("Revue", { exact: true }).first().textContent()).toBe("Revue");
  expect(await tab.getByTestId("review-title").textContent()).toBe("Revue · site · Acme");
  expect(await tab.getByTestId("review-top").evaluate((node) => getComputedStyle(node).backgroundColor)).toBe("rgb(217, 45, 32)");
  expect(await tab.getByTestId("review-progress").textContent()).toContain("0 / 2 vus");

  // The step: artboard large, then what changed, what to look at, the question.
  await expect.poll(() => tab.frameLocator("iframe").locator("h1").textContent()).toBe("List screen");
  const panel = tab.getByRole("complementary", { name: "Question de l'étape" });
  expect(await panel.textContent()).toContain("Home · List");
  expect(await panel.textContent()).toContain("The list.html changed");
  expect(await panel.textContent()).toContain("Look at list.html");
  expect(await panel.textContent()).toContain("Is the list fine?");

  // OK records the answer and opens the next step without one.
  await tab.getByRole("button", { name: "OK, étape suivante" }).click();
  await expect.poll(() => counter(tab).textContent()).toContain("Étape 2 / 2");
  expect(await tab.getByTestId("review-progress").textContent()).toContain("1 / 2 vus");
  await expect.poll(() => tab.frameLocator("iframe").locator("h1").textContent()).toBe("Empty screen");

  // Back on the first step the OK shows and can be cancelled.
  await tab.getByRole("button", { name: "← Précédente" }).click();
  await expect.poll(() => counter(tab).textContent()).toContain("Étape 1 / 2");
  await tab.getByRole("button", { name: "✓ Validé par toi · annuler" }).click();
  await expect.poll(() => tab.getByTestId("review-progress").textContent()).toContain("0 / 2 vus");
  await expect.poll(() => tab.getByRole("button", { name: "OK, étape suivante" }).count()).toBe(1);

  // Both steps validated: the last OK opens the recap, which finishes the review.
  await tab.getByRole("button", { name: "OK, étape suivante" }).click();
  await tab.getByRole("button", { name: "OK, étape suivante" }).click();
  await expect.poll(() => tab.getByRole("heading", { name: "Avant de terminer" }).count()).toBe(1);
  await tab.getByRole("button", { name: "Terminer la revue" }).first().click();
  await expect.poll(() => tab.getByText(/Revue terminée/).count()).toBeGreaterThan(0);
  expect(await tab.getByText(/j'ai fait mes retours/).count()).toBe(1);

  // Locked: opening a step shows no OK button any more.
  await tab.goto(`${seam.server.url}/#/reviews/${reviewId}/steps/1`);
  await expect.poll(() => counter(tab).textContent()).toContain("Étape 1 / 2");
  expect(await tab.getByRole("button", { name: "OK, étape suivante" }).count()).toBe(0);
  expect(await tab.getByText(/Revue terminée/).count()).toBeGreaterThan(0);
}, 60_000);

it("opens the review on the first step without an answer", async () => {
  const reviewId = await declareReview();
  const first = await (await fetch(`${seam.server.url}/api/change-reviews/${reviewId}`)).json() as { steps: { id: string }[] };
  await fetch(`${seam.server.url}/api/change-reviews/${reviewId}/steps/${first.steps[0]!.id}/ok`, { method: "PUT" });
  const tab = await browser.newPage({ viewport: { width: 1440, height: 900 } });

  await tab.goto(`${seam.server.url}/#/reviews/${reviewId}`);

  await expect.poll(() => counter(tab).textContent()).toContain("Étape 2 / 2");
}, 60_000);

it("says the review cannot be found when the link is wrong", async () => {
  const tab = await browser.newPage({ viewport: { width: 1440, height: 900 } });
  await tab.goto(`${seam.server.url}/#/reviews/00000000-0000-4000-8000-000000000000`);
  await expect.poll(() => tab.getByRole("heading", { name: "Revue introuvable" }).count()).toBe(1);
}, 60_000);

const stepsOf = async (reviewId: string) => ((await (await fetch(`${seam.server.url}/api/change-reviews/${reviewId}`)).json()) as ChangeReview).steps;
const remarkField = (tab: Page) => tab.getByRole("textbox", { name: "Ou une remarque" });

it("saves a remark on its own, replaces the OK, edits it, deletes it with an undo and keeps the text read-only when the review ends", async () => {
  const reviewId = await declareReview();
  const tab = await browser.newPage({ viewport: { width: 1440, height: 900 } });
  await tab.goto(`${seam.server.url}/#/reviews/${reviewId}`);
  await tab.getByRole("button", { name: "OK, étape suivante" }).click();
  await tab.getByRole("button", { name: "← Précédente" }).click();
  await expect.poll(() => tab.getByRole("button", { name: "✓ Validé par toi · annuler" }).count()).toBe(1);

  // Typing saves without any button; the remark replaces the OK.
  await remarkField(tab).fill("Move the list above the fold");
  await expect.poll(async () => (await stepsOf(reviewId))[0]!.answers.map((a) => a.kind)).toEqual(["remark"]);
  await expect.poll(() => tab.getByText("Toi · enregistré · modifiable jusqu'à la fin de la revue").count()).toBe(1);
  expect(await tab.getByText("Ta remarque remplace ton OK pour cette étape.").count()).toBe(1);
  expect(await tab.getByRole("button", { name: "OK, étape suivante" }).count()).toBe(0);
  const panel = tab.getByRole("complementary", { name: "Question de l'étape" });
  expect(await panel.textContent()).toContain("Remarque");
  expect(await tab.getByTestId("review-progress").textContent()).toContain("1 / 2 vus");

  // Editing saves the new text.
  await remarkField(tab).fill("Move the list above the fold, please");
  await expect.poll(async () => (await stepsOf(reviewId))[0]!.answers[0]!.text).toBe("Move the list above the fold, please");

  // Effacer can be undone for a few seconds.
  await tab.getByRole("button", { name: "Effacer" }).click();
  await tab.getByRole("button", { name: "Annuler" }).click();
  expect(await remarkField(tab).inputValue()).toBe("Move the list above the fold, please");
  expect((await stepsOf(reviewId))[0]!.answers).toHaveLength(1);

  // Effacer then waiting deletes it: the OK button is back.
  await tab.getByRole("button", { name: "Effacer" }).click();
  await expect.poll(async () => (await stepsOf(reviewId))[0]!.answers, { timeout: 10_000 }).toEqual([]);
  await expect.poll(() => tab.getByRole("button", { name: "OK, étape suivante" }).count()).toBe(1);

  // Finished review: the remark stays, read-only, with Copier.
  await remarkField(tab).fill("Last word");
  await expect.poll(async () => (await stepsOf(reviewId))[0]!.answers.length).toBe(1);
  await tab.getByRole("button", { name: "Terminer la revue" }).first().click();
  await tab.goto(`${seam.server.url}/#/reviews/${reviewId}/steps/1`);
  await expect.poll(() => tab.getByRole("textbox", { name: "Ta remarque" }).inputValue()).toBe("Last word");
  expect(await tab.getByRole("textbox", { name: "Ta remarque" }).getAttribute("readonly")).not.toBeNull();
  expect(await tab.getByRole("button", { name: "Copier" }).count()).toBe(1);
  expect(await tab.getByText(/plus de OK ni de remarque/).count()).toBe(1);
}, 60_000);

it("shows the failure with Réessayer, and asks before leaving a remark Redline has not received", async () => {
  const reviewId = await declareReview();
  const tab = await browser.newPage({ viewport: { width: 1440, height: 900 } });
  await tab.goto(`${seam.server.url}/#/reviews/${reviewId}`);
  await expect.poll(() => counter(tab).textContent()).toContain("Étape 1 / 2");
  let down = true;
  await tab.route("**/remark", (route) => (down ? route.abort() : route.continue()));

  await remarkField(tab).fill("Not received");
  await expect.poll(() => tab.getByText("Pas enregistré : Redline ne répond pas.").count()).toBe(1);

  await tab.getByRole("button", { name: "Suivante →" }).click();
  const dialog = tab.getByRole("dialog", { name: "Ta remarque n'est pas enregistrée : quitter quand même ?" });
  await expect.poll(() => dialog.count()).toBe(1);
  await dialog.getByRole("button", { name: "Rester" }).click();
  expect(await dialog.count()).toBe(0);
  await expect.poll(() => counter(tab).textContent()).toContain("Étape 1 / 2");

  down = false;
  await tab.getByRole("button", { name: "Réessayer" }).click();
  await expect.poll(async () => (await stepsOf(reviewId))[0]!.answers.map((a) => a.text)).toEqual(["Not received"]);

  // Saved: leaving asks nothing.
  await tab.getByRole("button", { name: "Suivante →" }).click();
  await expect.poll(() => counter(tab).textContent()).toContain("Étape 2 / 2");
}, 60_000);

it("leaves without saving when the member insists", async () => {
  const reviewId = await declareReview();
  const tab = await browser.newPage({ viewport: { width: 1440, height: 900 } });
  await tab.goto(`${seam.server.url}/#/reviews/${reviewId}`);
  await expect.poll(() => counter(tab).textContent()).toContain("Étape 1 / 2");
  await tab.route("**/remark", (route) => route.abort());
  await remarkField(tab).fill("Lost");
  await expect.poll(() => tab.getByText("Pas enregistré : Redline ne répond pas.").count()).toBe(1);

  await tab.getByRole("button", { name: "Suivante →" }).click();
  await tab.getByRole("button", { name: "Quitter sans enregistrer" }).click();

  await expect.poll(() => counter(tab).textContent()).toContain("Étape 2 / 2");
  expect((await stepsOf(reviewId))[0]!.answers).toEqual([]);
}, 60_000);
