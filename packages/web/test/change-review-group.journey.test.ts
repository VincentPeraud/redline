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
const FILES = { "list.html": "<!doctype html><h1>List screen</h1>", "empty.html": "<!doctype html><h1>Empty screen</h1>", "manifest.json": MANIFEST };
const SESSION = "7d6f3f6e-0000-4000-8000-000000000009";

/** A group of three artboards over two pages (the example is Home / List) and a single step on Home / Empty. */
async function declareReview(): Promise<{ reviewId: string; home: string; settings: string }> {
  const home = await seam.createPage(FILES, "Home");
  const settings = await seam.createPage(FILES, "Settings");
  const { token } = (await (await seam.server.get("/api/agent-token")).json()) as AgentTokenResponse;
  const headers = { authorization: `Bearer ${token}`, "content-type": "application/json" };
  await fetch(`${seam.server.url}/agent-api/terminal-sessions/${SESSION}/heartbeat`, { method: "POST", headers, body: JSON.stringify({ folder: "/work/site", machine: "Mac" }) });
  const texts = { changed: "A badge next to the name", lookAt: "The example is enough", question: "Is the badge fine?" };
  const response = await fetch(`${seam.server.url}/agent-api/terminal-sessions/${SESSION}/reviews`, {
    method: "POST",
    headers,
    body: JSON.stringify({
      folder: `/work/${home.id}/site`,
      steps: [
        { pageId: home.id, artboard: "list.html", title: "Badge cmux", others: [{ pageId: home.id, artboard: "empty.html" }, { pageId: settings.id, artboard: "list.html" }], ...texts },
        { pageId: home.id, artboard: "empty.html", ...texts, changed: "Single step" },
      ],
    }),
  });
  return { reviewId: ((await response.json()) as { id: string }).id, home: home.id, settings: settings.id };
}

const reviewOf = async (reviewId: string) => (await (await fetch(`${seam.server.url}/api/change-reviews/${reviewId}`)).json()) as ChangeReview;
const republish = (pageId: string) =>
  fetch(`${seam.server.url}/api/pages/${pageId}/versions`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ files: { ...FILES, "list.html": "<!doctype html><h1>List screen v2</h1>" }, message: "List again", origin: "terminal" }),
  });
const counter = (tab: Page) => tab.getByRole("button", { name: /^Étape \d+ \/ \d+/ });

it("shows a group as an example with thumbnails, remarks on the artboard shown first, and lists it under Sur plusieurs pages", async () => {
  const { reviewId, settings } = await declareReview();
  const tab = await browser.newPage({ viewport: { width: 1440, height: 900 } });

  await tab.goto(`${seam.server.url}/#/reviews/${reviewId}/steps/2`);

  await expect.poll(() => counter(tab).textContent()).toContain("Étape 2 / 2");
  const panel = tab.getByRole("complementary", { name: "Question de l'étape" });
  await expect.poll(() => panel.textContent()).toContain("2 pages · 3 artboards");
  expect(await panel.getByRole("heading", { level: 2 }).textContent()).toBe("Badge cmux (3 artboards)");
  expect(await panel.textContent()).toContain("Groupé");
  expect(await tab.getByRole("button", { name: "OK pour les 3" }).count()).toBe(1);
  expect(await tab.getByTestId("review-others").textContent()).toContain("Même changement sur 2 autres artboards");
  await counter(tab).click();
  expect(await tab.getByRole("menu").textContent()).toMatch(/Sur plusieurs pages.*Badge cmux \(3 artboards\)/);
  await tab.keyboard.press("Escape");

  // A thumbnail opens large, "Revenir à l'exemple" goes back.
  await tab.getByRole("button", { name: /Settings · List/ }).click();
  await expect.poll(() => tab.getByTestId("review-others").textContent()).toContain("Affiché : Settings · List");
  expect(await tab.locator(`iframe[title="Revue / list.html"]`).getAttribute("src")).toContain(`/pages/${settings}/list.html`);

  // A remark started on that artboard stays attached to it, whichever artboard is shown afterwards.
  await tab.getByRole("textbox", { name: "Ou une remarque pour tout le groupe" }).fill("Badge too big");
  await expect.poll(() => tab.getByLabel("Remarque sur Settings · List").count()).toBe(1);
  await tab.getByRole("button", { name: "Revenir à l'exemple" }).click();
  expect(await tab.getByLabel("Remarque sur Settings · List").inputValue()).toBe("Badge too big");
  await expect.poll(async () => (await reviewOf(reviewId)).steps[1]!.answers[0]).toMatchObject({ kind: "remark", on: { pageId: settings, artboard: "list.html" } });
}, 60_000);

it("validates the whole group once, and sends it back to Modifié, marking the artboard, when one of them is republished", async () => {
  const { reviewId, settings } = await declareReview();
  const tab = await browser.newPage({ viewport: { width: 1440, height: 900 } });
  await tab.goto(`${seam.server.url}/#/reviews/${reviewId}/steps/2`);
  await tab.getByRole("button", { name: "OK pour les 3" }).click();
  await expect.poll(async () => (await reviewOf(reviewId)).steps[1]!.answers.map((a) => a.kind)).toEqual(["ok"]);
  await expect.poll(() => counter(tab).textContent()).toContain("Étape 1 / 2");

  await republish(settings);
  await tab.goto(`${seam.server.url}/#/reviews/${reviewId}/steps/2`);
  await tab.reload();

  const panel = tab.getByRole("complementary", { name: "Question de l'étape" });
  await expect.poll(() => panel.textContent()).toContain("Modifié depuis ta revue");
  expect(await tab.getByRole("button", { name: /Settings · List/ }).textContent()).toContain("Modifié depuis ta revue");
  expect(await tab.getByRole("button", { name: /Home · Empty/ }).textContent()).not.toContain("Modifié depuis ta revue");
  expect(await panel.textContent()).toMatch(/ne compte plus : « Settings · List » a changé depuis/);
  await tab.getByRole("button", { name: "Revoir et valider les 3" }).click();
  await expect.poll(async () => (await reviewOf(reviewId)).steps[1]!.answers.map((a) => a.outdated ?? false)).toEqual([false]);
}, 60_000);
