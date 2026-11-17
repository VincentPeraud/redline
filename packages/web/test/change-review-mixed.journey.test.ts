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

const HTML = `<!doctype html><html><body style="margin:0;font-family:sans-serif"><h1>Réglages de l'instance</h1><a id="go" href="#">Voir les comptes rendus archivés</a></body></html>`;
const NOTE = { id: "note-archives", kind: "sticky", text: "Le lien mène à la page Archives.", width: 260, size: "m", color: "yellow", x: 1300, y: 140 };
const MANIFEST = JSON.stringify({ artboards: [{ file: "settings.html", title: "Instance", x: 60, y: 110, width: 1000, height: 640, frame: "browser" }], elements: [NOTE] });

let sessions = 0;
async function declare(step: Record<string, unknown> = {}, files: Record<string, string> = { "settings.html": HTML, "manifest.json": MANIFEST }): Promise<{ reviewId: string; pageId: string }> {
  sessions += 1;
  const folder = `/work/mixed-${sessions}`;
  const page = await seam.createPage(files, "Réglages");
  const { token } = (await (await seam.server.get("/api/agent-token")).json()) as AgentTokenResponse;
  const session = `7d6f3f6e-0000-4000-8000-0000000008${String(sessions).padStart(2, "0")}`;
  await fetch(`${seam.server.url}/agent-api/terminal-sessions/${session}/heartbeat`, { method: "POST", headers: { authorization: `Bearer ${token}`, "content-type": "application/json" }, body: JSON.stringify({ folder, machine: "Mac" }) });
  const response = await fetch(`${seam.server.url}/agent-api/terminal-sessions/${session}/reviews`, {
    method: "POST",
    headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
    body: JSON.stringify({
      folder,
      steps: [{ pageId: page.id, artboard: "settings.html", canvasElements: ["note-archives"], targets: ["#go"], changed: "Un lien et sa note.", lookAt: "1 : le lien, 2 : la note", question: "Le lien et sa note te vont ?", ...step }],
    }),
  });
  return { reviewId: ((await response.json()) as { id: string }).id, pageId: page.id };
}
const reviewOf = async (id: string) => (await (await seam.server.get(`/api/change-reviews/${id}`)).json()) as ChangeReview;
const open = async (reviewId: string) => {
  const tab = await browser.newPage({ viewport: { width: 1440, height: 900 } });
  await tab.goto(`${seam.server.url}/#/reviews/${reviewId}/steps/1`);
  return tab;
};

it("opens on the artboard with a strip of two views, and each view keeps its own controls", async () => {
  const { reviewId } = await declare();
  const tab = await open(reviewId);
  const frame = tab.frameLocator("iframe[title^=\"Revue\"]");
  await expect.poll(() => frame.locator("h1").textContent()).toBe("Réglages de l'instance");

  const strip = tab.getByTestId("review-views");
  expect(await strip.getByRole("button").allTextContents()).toEqual(["Réglages · Instance", "Canevas"]);
  expect(await tab.getByRole("button", { name: "Habillage" }).count()).toBe(1);
  expect(await tab.getByTestId("review-canvas").count()).toBe(0);
  expect(await tab.getByText("Page Réglages · artboard et canevas").count()).toBe(1);

  await strip.getByRole("button", { name: "Canevas" }).click();
  await expect.poll(() => tab.getByTestId("review-canvas").count()).toBe(1);
  expect(await tab.getByTestId("review-canvas-tag").textContent()).toBe("Canevas de la page · Réglages");
  expect(await tab.getByRole("button", { name: "Avant" }).isDisabled()).toBe(true);
  expect(await tab.getByRole("button", { name: "Habillage" }).count()).toBe(0);
  expect(await tab.getByRole("button", { name: "Tweaks" }).count()).toBe(0);
  expect(await tab.getByRole("button", { name: "Repères" }).count()).toBe(1);
  // The artboard's frame is number 1, so the note is number 2.
  await expect.poll(() => tab.locator('[data-canvas-target="2"]').count()).toBe(1);
  expect(await tab.locator('[data-canvas-target="1"]').count()).toBe(0);

  await strip.getByRole("button", { name: "Réglages · Instance" }).click();
  await expect.poll(() => tab.getByTestId("review-canvas").count()).toBe(0);
  expect(await tab.getByRole("button", { name: "Habillage" }).count()).toBe(1);

  await tab.close();
});

it("pins in each view, lists the pin of the other view with l'afficher", async () => {
  const { reviewId } = await declare();
  const tab = await open(reviewId);
  const frame = tab.frameLocator("iframe[title^=\"Revue\"]");
  await expect.poll(() => frame.locator("#go").count()).toBe(1);

  await frame.locator("#go").click({ modifiers: ["Alt"] });
  await tab.getByRole("textbox", { name: "Ton épingle" }).fill("Le lien est trop discret");
  await expect.poll(async () => (await reviewOf(reviewId)).steps[0]!.pins.map((pin) => ("kind" in pin.target ? pin.target.kind : "element"))).toEqual(["element"]);
  const list = tab.getByTestId("review-pins-list");
  expect(await list.textContent()).not.toContain("l'afficher");

  // On the canvas view the artboard pin is not drawn and is listed with "l'afficher".
  await tab.getByTestId("review-views").getByRole("button", { name: "Canevas" }).click();
  await expect.poll(() => tab.locator('[data-canvas-target="2"]').count()).toBe(1);
  expect(await tab.locator("[data-pin]").count()).toBe(0);
  expect(await list.textContent()).toContain("sur l'artboard");
  const frameBox = (await tab.locator('[data-canvas-target="2"]').boundingBox())!;
  await tab.keyboard.down("Alt");
  await tab.mouse.click(frameBox.x + frameBox.width / 2, frameBox.y + frameBox.height / 2);
  await tab.keyboard.up("Alt");
  await tab.getByRole("textbox", { name: "Ton épingle" }).fill("La note doit citer la page");
  await expect.poll(async () => (await reviewOf(reviewId)).steps[0]!.pins.map((pin) => [pin.number, "kind" in pin.target ? pin.target.kind : "element"])).toEqual([
    [1, "element"],
    [2, "canvas-element"],
  ]);
  expect(await tab.locator("[data-pin]").count()).toBe(1);

  // Back on the artboard, the canvas pin is the one listed with "l'afficher", which brings the canvas back.
  await tab.getByTestId("review-views").getByRole("button", { name: "Réglages · Instance" }).click();
  await expect.poll(() => tab.getByTestId("review-canvas").count()).toBe(0);
  const noteItem = list.locator('[data-pin-item="2"]');
  expect(await noteItem.textContent()).toContain("sur le canevas");
  await noteItem.getByRole("button", { name: "l'afficher" }).click();
  await expect.poll(() => tab.getByTestId("review-canvas").count()).toBe(1);

  await tab.close();
});

it("opens on the canvas when the artboard was deleted, and drops the Canevas thumbnail when the elements are gone", async () => {
  const gone = await declare();
  const otherManifest = JSON.stringify({ artboards: [{ file: "other.html", title: "Autre", x: 60, y: 110, width: 1000, height: 640, frame: "browser" }], elements: [NOTE] });
  await seam.server.post(`/api/pages/${gone.pageId}/versions`, { files: { "other.html": HTML, "manifest.json": otherManifest }, message: "Delete the artboard", origin: "user", confirmRemovals: true });
  const tab = await open(gone.reviewId);
  await expect.poll(() => tab.getByTestId("review-canvas").count()).toBe(1);
  expect(await tab.getByTestId("review-views").count()).toBe(0);
  await tab.close();

  const noElement = await declare();
  await seam.server.post(`/api/pages/${noElement.pageId}/versions`, { files: { "settings.html": HTML, "manifest.json": JSON.stringify({ artboards: [{ file: "settings.html", title: "Instance", x: 60, y: 110, width: 1000, height: 640, frame: "browser" }], elements: [] }) }, message: "Delete the note", origin: "user" });
  const second = await open(noElement.reviewId);
  await expect.poll(() => second.frameLocator("iframe[title^=\"Revue\"]").locator("h1").count()).toBe(1);
  expect(await second.getByTestId("review-views").count()).toBe(0);
  expect(await second.getByText("Page Réglages · artboard et canevas").count()).toBe(0);
  await second.close();
});
