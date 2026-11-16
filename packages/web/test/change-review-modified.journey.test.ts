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

async function declareReview(): Promise<{ reviewId: string; pageId: string }> {
  const page = await seam.createPage({ "list.html": "<!doctype html><h1>List screen</h1>", "empty.html": "<!doctype html><h1>Empty screen</h1>", "manifest.json": MANIFEST }, "Home");
  const { token } = (await (await seam.server.get("/api/agent-token")).json()) as AgentTokenResponse;
  const step = (artboard: string) => ({ pageId: page.id, artboard, changed: `The ${artboard} changed`, lookAt: `Look at ${artboard}`, question: `Is ${artboard} fine?` });
  await fetch(`${seam.server.url}/agent-api/terminal-sessions/7d6f3f6e-0000-4000-8000-000000000002/heartbeat`, {
    method: "POST",
    headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
    body: JSON.stringify({ folder: "/work/site", machine: "Mac" }),
  });
  const response = await fetch(`${seam.server.url}/agent-api/terminal-sessions/7d6f3f6e-0000-4000-8000-000000000002/reviews`, {
    method: "POST",
    headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
    body: JSON.stringify({ folder: `/work/${page.id}/site`, steps: [step("list.html"), step("empty.html")] }),
  });
  return { reviewId: ((await response.json()) as { id: string }).id, pageId: page.id };
}

const republishList = (pageId: string) =>
  fetch(`${seam.server.url}/api/pages/${pageId}/versions`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ files: { "list.html": "<!doctype html><h1>List screen v2</h1>", "empty.html": "<!doctype html><h1>Empty screen</h1>", "manifest.json": MANIFEST }, message: "List again", origin: "terminal" }),
  });
const stepsOf = async (reviewId: string) => ((await (await fetch(`${seam.server.url}/api/change-reviews/${reviewId}`)).json()) as ChangeReview).steps;
const counter = (tab: Page) => tab.getByRole("button", { name: /^Étape \d+ \/ \d+/ });
const answer = (reviewId: string, stepId: string, kind: "ok" | "remark") =>
  fetch(
    `${seam.server.url}/api/change-reviews/${reviewId}/steps/${stepId}/${kind}`,
    kind === "ok" ? { method: "PUT" } : { method: "PUT", headers: { "content-type": "application/json" }, body: JSON.stringify({ text: "Move the list up" }) },
  );

it("shows a republished step as modified and asks to check again with Revoir et valider", async () => {
  const { reviewId, pageId } = await declareReview();
  const [list, empty] = await stepsOf(reviewId);
  await answer(reviewId, list!.id, "ok");
  await answer(reviewId, empty!.id, "ok");
  await republishList(pageId);
  const tab = await browser.newPage({ viewport: { width: 1440, height: 900 } });

  await tab.goto(`${seam.server.url}/#/reviews/${reviewId}/steps/1`);

  // The modified step is tagged, red in the bar and in the menu.
  await expect.poll(() => counter(tab).textContent()).toContain("Étape 1 / 2");
  const panel = tab.getByRole("complementary", { name: "Question de l'étape" });
  await expect.poll(() => panel.textContent()).toContain("Modifié depuis ta revue");
  expect(await tab.getByTestId("review-modified-tag").textContent()).toMatch(/^Nouvelle version.* depuis ta revue · /);
  await expect.poll(() => tab.getByTestId("review-progress").textContent()).toContain("1 / 2 vus");
  await tab.getByRole("button", { name: "Suivante →" }).click();
  await expect.poll(() => counter(tab).textContent()).toContain("Étape 2 / 2");
  await counter(tab).click();
  expect(await tab.getByRole("menuitem", { name: /Modifié/ }).count()).toBe(1);
  await tab.keyboard.press("Escape");
  await tab.getByRole("button", { name: "← Précédente" }).click();
  await tab.getByRole("button", { name: "Revoir et valider" }).click();
  await expect.poll(async () => (await stepsOf(reviewId))[0]!.answers.map((a) => a.outdated ?? false)).toEqual([false]);
  await expect.poll(() => tab.getByTestId("review-modified-tag").count()).toBe(0);
}, 60_000);

it("keeps a remark on a modified step until the member clears it with Effacer ma remarque et valider", async () => {
  const { reviewId, pageId } = await declareReview();
  const [list] = await stepsOf(reviewId);
  await answer(reviewId, list!.id, "remark");
  await republishList(pageId);
  const tab = await browser.newPage({ viewport: { width: 1440, height: 900 } });

  await tab.goto(`${seam.server.url}/#/reviews/${reviewId}/steps/1`);

  await expect.poll(() => tab.getByText("Ta remarque d'avant la modification, gardée").count()).toBe(1);
  expect(await tab.getByRole("textbox", { name: "Remarque générale" }).inputValue()).toBe("Move the list up");
  await tab.getByRole("button", { name: "Effacer ma remarque et valider" }).click();

  await expect.poll(async () => (await stepsOf(reviewId))[0]!.answers.map((a) => a.kind), { timeout: 15_000 }).toEqual(["ok"]);
  await expect.poll(() => counter(tab).textContent()).toContain("Étape 2 / 2");
}, 60_000);
