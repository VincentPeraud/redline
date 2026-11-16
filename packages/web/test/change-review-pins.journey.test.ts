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

const MANIFEST = JSON.stringify({ artboards: [{ file: "list.html", title: "List", x: 0, y: 0, width: 1200, height: 800, frame: "browser" }] });
const HTML = `<!doctype html><body style="margin:0"><a id="go" href="https://example.com/away" style="display:block;padding:40px">Aller ailleurs</a><h1 style="margin:40px">Titre de la liste</h1><button id="b" onclick="document.title='clicked'">Valider</button></body>`;

async function declareReview(): Promise<{ reviewId: string; stepId: string }> {
  const page = await seam.createPage({ "list.html": HTML, "manifest.json": MANIFEST }, "Home");
  const { token } = (await (await seam.server.get("/api/agent-token")).json()) as AgentTokenResponse;
  const session = "7d6f3f6e-0000-4000-8000-000000000003";
  await fetch(`${seam.server.url}/agent-api/terminal-sessions/${session}/heartbeat`, { method: "POST", headers: { authorization: `Bearer ${token}`, "content-type": "application/json" }, body: JSON.stringify({ folder: "/work/site", machine: "Mac" }) });
  const response = await fetch(`${seam.server.url}/agent-api/terminal-sessions/${session}/reviews`, {
    method: "POST",
    headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
    body: JSON.stringify({ folder: "/work/site", steps: [{ pageId: page.id, artboard: "list.html", changed: "c", lookAt: "l", question: "Is the list fine?" }] }),
  });
  const reviewId = ((await response.json()) as { id: string }).id;
  const review = (await (await seam.server.get(`/api/change-reviews/${reviewId}`)).json()) as ChangeReview;
  return { reviewId, stepId: review.steps[0]!.id };
}

it("pins an element with Alt + click without following the link, saves its text, lists it, and drops an empty pin on close", async () => {
  const { reviewId } = await declareReview();
  const tab = await browser.newPage({ viewport: { width: 1440, height: 900 } });
  await tab.goto(`${seam.server.url}/#/reviews/${reviewId}/steps/1`);
  const frame = tab.frameLocator("iframe");
  await expect.poll(() => frame.locator("h1").textContent()).toBe("Titre de la liste");
  await expect.poll(() => tab.getByTestId("review-pin-hint").textContent()).toContain("Alt + clic : épingler un élément");

  // Alt + click on a link pins it and does not navigate.
  await frame.locator("#go").click({ modifiers: ["Alt"] });
  const dialog = tab.getByRole("dialog", { name: "Épingle 1" });
  await expect.poll(() => dialog.count()).toBe(1);
  expect(tab.url()).toContain("#/reviews/");

  // An empty pin disappears on close and takes no number.
  await dialog.getByRole("button", { name: "Fermer" }).click();
  await expect.poll(() => tab.locator("[data-pin]").count()).toBe(0);

  await frame.locator("h1").click({ modifiers: ["Alt"] });
  await tab.getByRole("textbox", { name: "Ton épingle" }).fill("Le titre est trop petit");
  await expect.poll(async () => ((await (await seam.server.get(`/api/change-reviews/${reviewId}`)).json()) as ChangeReview).steps[0]!.pins.map((pin) => [pin.number, pin.text])).toEqual([[1, "Le titre est trop petit"]]);
  await expect.poll(() => tab.getByTestId("review-pins-list").textContent()).toContain("Le titre est trop petit");
  expect(await tab.getByTestId("review-pins-list").textContent()).toContain("Tes épingles et zones (1)");
  expect(await tab.getByText("Ton épingle remplace ton OK pour cette étape.").count()).toBe(1);
  await expect.poll(() => tab.locator('[data-pin="1"][data-pin-mine="true"]').count()).toBe(1);

  await tab.close();
});

it("shows a pin added elsewhere on the stage without reloading", async () => {
  const { reviewId, stepId } = await declareReview();
  const tab = await browser.newPage({ viewport: { width: 1440, height: 900 } });
  await tab.goto(`${seam.server.url}/#/reviews/${reviewId}/steps/1`);
  await expect.poll(() => tab.frameLocator("iframe").locator("h1").textContent()).toBe("Titre de la liste");

  const added = await fetch(`${seam.server.url}/api/change-reviews/${reviewId}/steps/${stepId}/pins`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ text: "Avec le même nom", target: { selector: "h1", elementName: "titre", xPct: 20, yPct: 20 } }) });
  expect(added.status).toBe(200);
  await expect.poll(() => tab.locator("[data-pin]").count()).toBe(1);
  await tab.close();
});
