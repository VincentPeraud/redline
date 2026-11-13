import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import Database from "better-sqlite3";
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

const MANIFEST = JSON.stringify({
  artboards: [
    { file: "list.html", title: "List", x: 0, y: 0, width: 1200, height: 800, frame: "browser" },
    { file: "empty.html", title: "Empty", x: 1300, y: 0, width: 1200, height: 800, frame: "browser" },
  ],
});

async function declareReview(label: string): Promise<{ reviewId: string; pageId: string }> {
  const page = await seam.createPage({ "list.html": "<!doctype html><h1>List screen</h1>", "empty.html": "<!doctype html><h1>Empty screen</h1>", "manifest.json": MANIFEST }, "Home");
  const { token } = (await (await seam.server.get("/api/agent-token")).json()) as AgentTokenResponse;
  const step = (artboard: string) => ({ pageId: page.id, artboard, changed: `The ${artboard} changed`, lookAt: `Look at ${artboard}`, question: "Fine?" });
  const response = await fetch(`${seam.server.url}/agent-api/terminal-sessions/7d6f3f6e-0000-4000-8000-000000000002/reviews`, {
    method: "POST",
    headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
    body: JSON.stringify({ folder: "/work/site", label, steps: [step("list.html"), step("empty.html")] }),
  });
  return { reviewId: ((await response.json()) as { id: string }).id, pageId: page.id };
}

const reviewOf = async (id: string) => (await (await fetch(`${seam.server.url}/api/change-reviews/${id}`)).json()) as ChangeReview;
const ok = async (reviewId: string, index: number) => fetch(`${seam.server.url}/api/change-reviews/${reviewId}/steps/${(await reviewOf(reviewId)).steps[index]!.id}/ok`, { method: "PUT" });

it("shows the banner in its four states, live on a second browser, and resumes on the first step without an answer", async () => {
  const { reviewId, pageId } = await declareReview("agora-maquettes");
  const first = await (await browser.newContext({ viewport: { width: 1440, height: 900 } })).newPage();
  const second = await (await browser.newContext({ viewport: { width: 1440, height: 900 } })).newPage();
  for (const tab of [first, second]) await tab.goto(`${seam.server.url}/#/pages/${pageId}`);
  const banner = (tab: typeof first) => tab.getByTestId("review-banner");

  // Requested.
  await expect.poll(() => banner(first).textContent()).toContain("Claude demande une revue · 2 étapes sur 1 page");
  expect(await banner(first).textContent()).toContain("Home · demandée à l'instant par ta conversation (agora-maquettes)");
  expect(await banner(first).evaluate((node) => getComputedStyle(node).backgroundColor)).toBe("rgb(255, 244, 229)");

  // In progress, live on the other browser: step 1 answered by someone.
  await ok(reviewId, 0);
  await expect.poll(() => banner(second).textContent()).toContain("Revue en cours · 1 / 2 vus");
  expect(await banner(second).textContent()).toContain("1 OK");

  // Reprendre opens the first step without an answer (the second one).
  await banner(second).getByRole("button", { name: "Reprendre" }).click();
  await expect.poll(() => second.getByRole("button", { name: /^Étape \d+ \/ \d+/ }).textContent()).toContain("Étape 2 / 2");

  // Finished, waiting for fetch: no close button, a way to the recap.
  await second.goto(`${seam.server.url}/#/pages/${pageId}`);
  await fetch(`${seam.server.url}/api/change-reviews/${reviewId}/finish`, { method: "POST" });
  await expect.poll(() => banner(first).textContent()).toContain("en attente de récupération");
  expect(await banner(first).getByRole("button", { name: "Masquer le bandeau" }).count()).toBe(0);
  expect(await banner(first).textContent()).toContain("j'ai fait mes retours");
  await banner(first).getByRole("button", { name: "Voir le récapitulatif" }).click();
  expect(first.url()).toContain(`#/reviews/${reviewId}/recap`);

  // Fetched within the hour: the green banner shows on load, and can be hidden.
  const db = new Database(join(seam.server.dataDir, "redline.db"));
  db.prepare("UPDATE change_reviews SET state = 'fetched', fetched_at = ? WHERE id = ?").run(new Date().toISOString(), reviewId);
  db.close();
  await first.goto(`${seam.server.url}/#/pages/${pageId}`);
  await first.reload();
  await expect.poll(() => banner(first).textContent()).toContain("Retours récupérés par");
  expect(await banner(first).evaluate((node) => getComputedStyle(node).backgroundColor)).toBe("rgb(231, 246, 236)");
  await banner(first).getByRole("button", { name: "Masquer le bandeau" }).click();
  await expect.poll(() => banner(first).count()).toBe(0);
}, 90_000);

it("updates an open review screen when another member answers", async () => {
  const { reviewId } = await declareReview("live");
  const tab = await browser.newPage({ viewport: { width: 1440, height: 900 } });
  await tab.goto(`${seam.server.url}/#/reviews/${reviewId}`);
  await expect.poll(() => tab.getByTestId("review-progress").textContent()).toContain("0 / 2 vus");

  await ok(reviewId, 1);

  await expect.poll(() => tab.getByTestId("review-progress").textContent()).toContain("1 / 2 vus");
}, 60_000);
