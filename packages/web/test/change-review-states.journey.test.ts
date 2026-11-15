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

const FILES = {
  "list.html": "<!doctype html><h1>List screen</h1>",
  "meeting.html": "<!doctype html><h1>Meeting screen</h1>",
  "form.html": "<!doctype html><h1>Form screen</h1>",
  "manifest.json": JSON.stringify({
    artboards: [
      { file: "list.html", title: "List", x: 0, y: 0, width: 1200, height: 800, frame: "browser" },
      { file: "meeting.html", title: "Recording", x: 1300, y: 0, width: 1200, height: 800, frame: "browser" },
      { file: "form.html", title: "Form", x: 2600, y: 0, width: 1200, height: 800, frame: "browser" },
    ],
  }),
};

let sessions = 0;
async function declareReview(files: string[]): Promise<{ reviewId: string; pageId: string }> {
  const page = await seam.createPage(FILES, "Meetings");
  const { token } = (await (await seam.server.get("/api/agent-token")).json()) as AgentTokenResponse;
  const session = `7d6f3f6e-0000-4000-8000-0000000001${String(++sessions).padStart(2, "0")}`;
  const headers = { authorization: `Bearer ${token}`, "content-type": "application/json" };
  await fetch(`${seam.server.url}/agent-api/terminal-sessions/${session}/heartbeat`, { method: "POST", headers, body: JSON.stringify({ folder: "/work/site", machine: "Mac" }) });
  const step = (artboard: string) => ({ pageId: page.id, artboard, changed: `The ${artboard} changed`, lookAt: `Look at ${artboard}`, question: `Is ${artboard} fine?` });
  const response = await fetch(`${seam.server.url}/agent-api/terminal-sessions/${session}/reviews`, { method: "POST", headers, body: JSON.stringify({ folder: `/work/${page.id}/site`, steps: files.map(step) }) });
  return { reviewId: ((await response.json()) as { id: string }).id, pageId: page.id };
}
const deleteArtboards = (pageId: string, gone: string[]) =>
  fetch(`${seam.server.url}/api/pages/${pageId}/versions`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ files: Object.fromEntries(Object.entries(FILES).filter(([file]) => !gone.includes(file))), message: "Delete", origin: "user", confirmRemovals: true }),
  });
const reviewOf = async (reviewId: string) => (await (await fetch(`${seam.server.url}/api/change-reviews/${reviewId}`)).json()) as ChangeReview;

it("shows a deleted artboard's step as removed, with the count dropped, and moves on with Étape suivante", async () => {
  const { reviewId, pageId } = await declareReview(["list.html", "meeting.html", "form.html"]);
  await deleteArtboards(pageId, ["meeting.html"]);
  const tab = await browser.newPage({ viewport: { width: 1440, height: 900 } });

  await tab.goto(`${seam.server.url}/#/reviews/${reviewId}/steps/2`);

  await tab.getByRole("heading", { name: "Cet artboard n'existe plus" }).waitFor();
  await expect(tab.getByTestId("review-removed").textContent()).resolves.toContain("« Meetings · Recording » a été supprimé depuis la demande de revue. L'étape est retirée du compte.");
  await expect(tab.getByRole("button", { name: /^Étape \d+ \/ \d+/ }).textContent()).resolves.toContain("Étape 2 / 2");
  await tab.getByRole("button", { name: "Étape suivante →" }).click();
  await tab.getByRole("heading", { name: "Meetings · Form" }).waitFor();
  await expect(tab.getByRole("button", { name: /^Étape \d+ \/ \d+/ }).textContent()).resolves.toContain("Étape 2 / 2");
  await tab.close();
});

it("shows the empty screen of a review filed because every artboard was deleted", async () => {
  const { reviewId, pageId } = await declareReview(["list.html", "meeting.html"]);
  await deleteArtboards(pageId, ["list.html", "meeting.html"]);
  expect((await reviewOf(reviewId)).state).toBe("filed");
  const tab = await browser.newPage({ viewport: { width: 1440, height: 900 } });

  await tab.goto(`${seam.server.url}/#/reviews/${reviewId}`);

  await tab.getByRole("heading", { name: "Plus rien à revoir" }).waitFor();
  await expect(tab.getByText("Les 2 artboards de cette revue ont été supprimés depuis la demande. Demande à Claude de refaire la revue si besoin.").isVisible()).resolves.toBe(true);
  await expect(tab.getByTestId("review-title").textContent()).resolves.toContain("Revue");
  await tab.getByRole("button", { name: "Retour au canvas" }).waitFor();
  await tab.close();
});

it("shows the not found screen for a review that does not exist, with a way back", async () => {
  const tab = await browser.newPage({ viewport: { width: 1440, height: 900 } });

  await tab.goto(`${seam.server.url}/#/reviews/00000000-0000-4000-8000-000000000000`);

  await tab.getByRole("heading", { name: "Revue introuvable" }).waitFor();
  await tab.getByText("Ce lien ne correspond à aucune revue : il est incomplet, ou le projet a été supprimé.").waitFor();
  expect(await tab.getByTestId("review-title").count()).toBe(0);
  await tab.getByRole("button", { name: "Retour au projet" }).waitFor();
  await tab.close();
});

it("shows the loading screen, then the error screen with Réessayer, and loads the review once the server answers again", async () => {
  const { reviewId } = await declareReview(["list.html"]);
  const tab = await browser.newPage({ viewport: { width: 1440, height: 900 } });
  let release: () => void = () => undefined;
  const held = new Promise<void>((resolve) => (release = resolve));
  let failing = true;
  await tab.route(`**/api/change-reviews/${reviewId}`, async (route) => {
    await held;
    if (failing) await route.abort();
    else await route.continue();
  });

  await tab.goto(`${seam.server.url}/#/reviews/${reviewId}`);
  await tab.getByText("Chargement de la revue").waitFor();
  release();

  await tab.getByRole("heading", { name: "La revue n'a pas pu se charger" }).waitFor();
  await tab.getByText("Le serveur Redline ne répond pas. Tes OK et tes remarques déjà faits sont enregistrés.").waitFor();
  failing = false;
  await tab.getByRole("button", { name: "Réessayer" }).click();
  await tab.getByRole("button", { name: /^Étape 1 \/ 1/ }).waitFor();
  await tab.close();
});

it("keeps the review and the text being typed when a background reload fails", async () => {
  const { reviewId } = await declareReview(["list.html", "meeting.html"]);
  const tab = await browser.newPage({ viewport: { width: 1440, height: 900 } });
  await tab.goto(`${seam.server.url}/#/reviews/${reviewId}/steps/1`);
  const remark = tab.getByRole("textbox", { name: /remarque/ });
  await remark.fill("Typed while the server hiccups");
  await expect.poll(async () => (await reviewOf(reviewId)).steps[0]!.answers.length).toBe(1);

  // Another member answers: the screen reloads, and the server does not answer this time.
  await tab.route(`**/api/change-reviews/${reviewId}`, (route) => route.abort());
  const second = (await reviewOf(reviewId)).steps[1]!;
  await fetch(`${seam.server.url}/api/change-reviews/${reviewId}/steps/${second.id}/ok`, { method: "PUT" });
  await tab.waitForTimeout(800);

  expect(await tab.getByTestId("review-title").count()).toBe(1);
  expect(await tab.getByRole("button", { name: "Réessayer" }).count()).toBe(0);
  expect(await remark.inputValue()).toBe("Typed while the server hiccups");
  await tab.close();
});
