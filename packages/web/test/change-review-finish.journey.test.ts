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

/** A review of three artboards of one page, declared as a terminal session does. */
async function declareReview(): Promise<string> {
  const page = await seam.createPage(
    { "list.html": "<!doctype html><h1>List screen</h1>", "empty.html": "<!doctype html><h1>Empty screen</h1>", "detail.html": "<!doctype html><h1>Detail screen</h1>", "manifest.json": MANIFEST },
    "Home",
  );
  const { token } = (await (await seam.server.get("/api/agent-token")).json()) as AgentTokenResponse;
  const sessionId = `7d6f3f6e-0000-4000-8000-00000000010${sessionNumber++}`;
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
const post = (reviewId: string, path: string) => fetch(api(reviewId, path), { method: "POST" });
const saveRemark = (reviewId: string, stepId: string, text: string) => fetch(api(reviewId, `/steps/${stepId}/remark`), { method: "PUT", headers: { "content-type": "application/json" }, body: JSON.stringify({ text }) });
const okOn = (reviewId: string, stepId: string) => fetch(api(reviewId, `/steps/${stepId}/ok`), { method: "PUT" });
const open = async (reviewId: string, hash: string) => {
  const tab = await browser.newPage({ viewport: { width: 1440, height: 900 } });
  await tab.goto(`${seam.server.url}/#/reviews/${reviewId}${hash}`);
  return tab;
};
const heading = (tab: Page, name: string | RegExp) => tab.getByRole("heading", { name });

it("shows the recap in two columns on the top bar's edges, with counts, remarks, OKs and the steps not seen", async () => {
  const reviewId = await declareReview();
  const [first, second] = (await reviewOf(reviewId)).steps;
  await okOn(reviewId, first!.id);
  await saveRemark(reviewId, second!.id, "Put the decisions first");

  const tab = await open(reviewId, "/recap");

  await expect.poll(() => heading(tab, "Avant de terminer").count()).toBe(1);
  expect(await tab.getByRole("button", { name: /^Récapitulatif/ }).textContent()).toContain("2 / 3 vus");
  const box = async (selector: string) => (await tab.locator(selector).first().boundingBox())!;
  const lead = await box('[data-testid="review-top"] > div');
  const left = await tab.getByRole("heading", { name: "Avant de terminer" }).boundingBox();
  const list = await tab.getByText(/^Retours \(\d+ sur \d+ étapes?\)$/).first().boundingBox();
  expect(Math.round(left!.x)).toBe(Math.round(lead.x));
  expect(Math.round(list!.x + list!.width)).toBeLessThanOrEqual(1440 - 20);
  expect(list!.x).toBeGreaterThan(left!.x + 400);
  const text = await tab.getByTestId("review").innerText();
  expect(text).toContain("Home · Empty");
  expect(text).toContain("Put the decisions first");
  expect(text).toMatch(/Home · List \(toi\)/);
  expect(text).toMatch(/non vus \(1\)/i);
  expect(await tab.getByRole("button", { name: "Modifier" }).count()).toBe(1);
}, 60_000);

it("asks before finishing when steps were not seen, and finishes on confirmation", async () => {
  const reviewId = await declareReview();
  const tab = await open(reviewId, "/recap");
  await expect.poll(() => heading(tab, "Avant de terminer").count()).toBe(1);

  await tab.getByRole("button", { name: "Terminer la revue" }).click();

  const dialog = tab.getByRole("dialog", { name: "3 étapes non vues : terminer quand même ?" });
  await expect.poll(() => dialog.count()).toBe(1);
  await dialog.getByRole("button", { name: "Continuer la revue" }).click();
  expect((await reviewOf(reviewId)).state).toBe("open");

  await tab.getByRole("button", { name: "Terminer la revue" }).click();
  await tab.getByRole("button", { name: "Terminer quand même" }).click();
  await expect.poll(() => heading(tab, "Revue terminée").count()).toBe(1);
  expect((await reviewOf(reviewId)).state).toBe("finished");
}, 60_000);

it("asks before finishing when another member is still in the review, and finishes without a question otherwise", async () => {
  const reviewId = await declareReview();
  for (const entry of (await reviewOf(reviewId)).steps) await okOn(reviewId, entry.id);
  const tab = await open(reviewId, "/recap");
  await expect.poll(() => heading(tab, "Avant de terminer").count()).toBe(1);
  // Presence of another member is in memory on the server: here the screen's answer is given a member in step 2.
  await tab.route(`**/api/change-reviews/${reviewId}`, async (route) => {
    const response = await route.fetch();
    const review = (await response.json()) as ChangeReview;
    await route.fulfill({ response, json: { ...review, present: [{ person: { id: "v", name: "Victor", email: "v@x.test", initials: "VI" }, step: 2 }] } });
  });

  await tab.getByRole("button", { name: "Terminer la revue" }).click();

  const dialog = tab.getByRole("dialog", { name: "Terminer la revue ?" });
  await expect.poll(() => dialog.count()).toBe(1);
  expect(await dialog.textContent()).toContain("Victor est encore dans la revue (étape 2).");
  await dialog.getByRole("button", { name: "Terminer quand même" }).click();
  await expect.poll(async () => (await reviewOf(reviewId)).state).toBe("finished");

  const other = await declareReview();
  for (const entry of (await reviewOf(other)).steps) await okOn(other, entry.id);
  const quiet = await open(other, "/recap");
  await quiet.getByRole("button", { name: "Terminer la revue" }).click();
  await expect.poll(async () => (await reviewOf(other)).state).toBe("finished");
}, 60_000);

it("shows the finished recap with the reminder, reopens it, and files it for good after a confirmation naming the remarks", async () => {
  const reviewId = await declareReview();
  const steps = (await reviewOf(reviewId)).steps;
  await okOn(reviewId, steps[0]!.id);
  await saveRemark(reviewId, steps[1]!.id, "Too dense");
  await post(reviewId, "/finish");
  const tab = await open(reviewId, "/recap");

  await expect.poll(() => heading(tab, "Revue terminée").count()).toBe(1);
  expect(await tab.getByTestId("review").innerText()).toMatch(/Terminée par .* · .*\n.*Dis maintenant à ta conversation site que tes retours sont prêts/s);
  expect(await tab.getByRole("button", { name: "Modifier" }).count()).toBe(0);

  await tab.getByRole("button", { name: "Rouvrir la revue" }).click();
  await expect.poll(() => heading(tab, "Avant de terminer").count()).toBe(1);
  expect((await reviewOf(reviewId)).state).toBe("open");

  await post(reviewId, "/finish");
  await expect.poll(() => heading(tab, "Revue terminée").count()).toBe(1);
  await tab.getByRole("button", { name: "Classer sans envoyer" }).click();
  const dialog = tab.getByRole("dialog", { name: "Classer sans envoyer ?" });
  expect(await dialog.textContent()).toContain("Ton retour ne sera jamais transmis à une conversation. C'est définitif : la revue ne pourra plus être rouverte.");
  await dialog.getByRole("button", { name: "Annuler" }).click();
  expect((await reviewOf(reviewId)).state).toBe("finished");

  await tab.getByRole("button", { name: "Classer sans envoyer" }).click();
  await dialog.getByRole("button", { name: "Classer sans envoyer" }).click();
  await expect.poll(() => tab.getByText(/Classée sans envoi par/).count()).toBe(1);
  expect((await reviewOf(reviewId)).state).toBe("filed");
  expect(await tab.getByRole("button", { name: "Rouvrir la revue" }).count()).toBe(0);
  expect(await tab.getByText("Lecture seule : retour au canvas par le bouton en haut à gauche.").count()).toBe(1);
}, 60_000);

it("shows a review fetched by a conversation as read-only, with who fetched it", async () => {
  const reviewId = await declareReview();
  const steps = (await reviewOf(reviewId)).steps;
  await saveRemark(reviewId, steps[0]!.id, "Nope");
  await post(reviewId, "/finish");
  const { token } = (await (await seam.server.get("/api/agent-token")).json()) as AgentTokenResponse;
  const sessionId = "7d6f3f6e-0000-4000-8000-000000000199";
  const headers = { authorization: `Bearer ${token}`, "content-type": "application/json" };
  await fetch(`${seam.server.url}/agent-api/terminal-sessions/${sessionId}/heartbeat`, { method: "POST", headers, body: JSON.stringify({ folder: "/work/site", machine: "Mac" }) });
  await fetch(`${seam.server.url}/agent-api/terminal-sessions/${sessionId}/review-feedback`, { method: "POST", headers, body: JSON.stringify({ reviewId }) });

  const tab = await open(reviewId, "/recap");

  await expect.poll(() => tab.getByText(/Récupérée par/).count()).toBe(1);
  expect(await tab.getByText("Le retour est devenu un fil sur son artboard. Cette revue reste lisible ici.").count()).toBe(1);
  expect(await tab.getByRole("button", { name: "Rouvrir la revue" }).count()).toBe(0);
  expect(await tab.getByRole("button", { name: "Classer sans envoyer" }).count()).toBe(0);
}, 60_000);

it("turns a step read-only while a member types, keeping the unsaved text with Copier and a way to reopen", async () => {
  const reviewId = await declareReview();
  const tab = await open(reviewId, "/steps/1");
  await expect.poll(() => tab.getByRole("textbox", { name: "Remarque générale" }).count()).toBe(1);
  // The text is typed while Redline cannot save it, then somebody finishes the review.
  await tab.route("**/remark", (route) => route.abort());
  await tab.getByRole("textbox", { name: "Remarque générale" }).fill("Mets les décisions au-dessus");
  await expect.poll(() => tab.getByText("Pas enregistré : Redline ne répond pas.").count()).toBe(1);

  await post(reviewId, "/finish");

  const kept = tab.getByRole("textbox", { name: "Ta remarque (non enregistrée)" });
  await expect.poll(() => kept.count()).toBe(1);
  expect(await kept.inputValue()).toBe("Mets les décisions au-dessus");
  expect(await kept.getAttribute("readonly")).not.toBeNull();
  expect(await tab.getByText(/Non enregistré ·/).count()).toBe(1);
  expect(await tab.getByRole("button", { name: "Copier" }).count()).toBe(1);
  expect(await tab.getByText("Lecture seule", { exact: true }).count()).toBe(1);
  expect(await tab.getByText(/Ton texte non enregistré est gardé ci-dessous pour que tu le copies\./).count()).toBe(1);

  await tab.unroute("**/remark");
  await tab.getByRole("button", { name: "Rouvrir la revue" }).click();
  await expect.poll(() => tab.getByRole("textbox", { name: "Remarque générale" }).count()).toBe(1);
  expect((await reviewOf(reviewId)).state).toBe("open");
  // Once the review is open again the text that was kept is saved.
  await expect.poll(async () => (await reviewOf(reviewId)).steps[0]!.answers.map((answer) => answer.text)).toEqual(["Mets les décisions au-dessus"]);
}, 60_000);

it("deletes a remark from the recap, with an undo while the review is open", async () => {
  const reviewId = await declareReview();
  const steps = (await reviewOf(reviewId)).steps;
  await saveRemark(reviewId, steps[0]!.id, "Remove me");
  const tab = await open(reviewId, "/recap");
  await expect.poll(() => tab.getByRole("button", { name: "Effacer" }).count()).toBe(1);

  await tab.getByRole("button", { name: "Effacer" }).click();
  await expect.poll(async () => (await reviewOf(reviewId)).steps[0]!.answers).toEqual([]);
  await tab.getByRole("button", { name: "Annuler" }).click();

  await expect.poll(async () => (await reviewOf(reviewId)).steps[0]!.answers.map((answer) => answer.text)).toEqual(["Remove me"]);
}, 60_000);

it("groups pins, zones and the general remark by step in the recap, deletes a pin from it, then shows the finished recap read-only", async () => {
  const reviewId = await declareReview();
  const [first, second] = (await reviewOf(reviewId)).steps;
  const addPin = (stepId: string, body: unknown) => fetch(api(reviewId, `/steps/${stepId}/pins`), { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
  await addPin(first!.id, { text: "Make it bold", target: { selector: "h1", elementName: "titre « List screen »", xPct: 10, yPct: 10 } });
  await addPin(first!.id, { text: "Participants under decisions", target: { kind: "zone", space: "artboard", xPct: 10, yPct: 10, wPct: 30, hPct: 20 } });
  await saveRemark(reviewId, second!.id, "Help text too long");
  const tab = await open(reviewId, "/recap");

  await expect.poll(() => tab.getByText("Retours (3 sur 2 étapes)").count()).toBe(1);
  const text = await tab.getByTestId("review").innerText();
  expect(text).toContain("« List screen »");
  expect(text).toContain("Zone");
  expect(text).toContain("Remarque générale");
  expect(text).toMatch(/2\s*\n?Étapes avec retours/);
  expect(await tab.getByRole("button", { name: "Effacer" }).count()).toBe(3);

  await tab.getByRole("button", { name: "Effacer" }).first().click();
  await expect.poll(async () => (await reviewOf(reviewId)).steps[0]!.pins.map((pin) => pin.text)).toEqual(["Participants under decisions"]);
  await expect.poll(() => tab.getByText("Retours (2 sur 2 étapes)").count()).toBe(1);

  await tab.getByRole("button", { name: "Terminer la revue" }).click();
  await tab.getByRole("button", { name: "Terminer quand même" }).click();
  await expect.poll(() => heading(tab, "Revue terminée").count()).toBe(1);
  expect(await tab.getByRole("button", { name: "Effacer" }).count()).toBe(0);
  expect(await tab.getByRole("button", { name: "Modifier" }).count()).toBe(0);
  expect(await tab.getByText("Participants under decisions").count()).toBe(1);
}, 60_000);
