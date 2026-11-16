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

const manifest = (elements: unknown[]) =>
  JSON.stringify({
    artboards: [
      { file: "a.html", title: "Annonce courte · A", x: 48, y: 96, width: 200, height: 250 },
      { file: "b.html", title: "Annonce courte · A3", x: 288, y: 96, width: 200, height: 250 },
    ],
    elements,
  });
const NOTE = { id: "note-candidats", kind: "sticky", text: "Les 8 candidats sont sur la page des explorations.", width: 240, size: "m", color: "yellow", x: 560, y: 124 };
const FILES = (elements: unknown[] = [NOTE]) => ({ "a.html": "<!doctype html><h1>A</h1>", "b.html": "<!doctype html><h1>B</h1>", "manifest.json": manifest(elements) });

let sessions = 0;
async function declare(files = FILES(), steps?: (pageId: string) => unknown[]): Promise<{ reviewId: string; pageId: string }> {
  sessions += 1;
  const folder = `/work/canvas-${sessions}`;
  const page = await seam.createPage(files, "Carrousel");
  const { token } = (await (await seam.server.get("/api/agent-token")).json()) as AgentTokenResponse;
  const session = `7d6f3f6e-0000-4000-8000-0000000007${String(sessions).padStart(2, "0")}`;
  await fetch(`${seam.server.url}/agent-api/terminal-sessions/${session}/heartbeat`, { method: "POST", headers: { authorization: `Bearer ${token}`, "content-type": "application/json" }, body: JSON.stringify({ folder, machine: "Mac" }) });
  const response = await fetch(`${seam.server.url}/agent-api/terminal-sessions/${session}/reviews`, {
    method: "POST",
    headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
    body: JSON.stringify({ folder, steps: steps?.(page.id) ?? [{ pageId: page.id, canvasElements: ["note-candidats"], changed: "Les explorations sont parties ailleurs.", lookAt: "La note, et son lien.", question: "La note suffit pour retrouver les candidats ?" }] }),
  });
  return { reviewId: ((await response.json()) as { id: string }).id, pageId: page.id };
}
const reviewOf = async (id: string) => (await (await seam.server.get(`/api/change-reviews/${id}`)).json()) as ChangeReview;
const open = async (reviewId: string, viewport = { width: 1440, height: 900 }): Promise<Page> => {
  const tab = await browser.newPage({ viewport });
  await tab.goto(`${seam.server.url}/#/reviews/${reviewId}/steps/1`);
  await expect.poll(() => tab.getByTestId("review-canvas").count()).toBe(1);
  return tab;
};

it("shows the canvas cropped on the note, with its tag, a disabled Avant and no Tweaks or Habillage", async () => {
  const { reviewId } = await declare();
  const tab = await open(reviewId);

  expect(await tab.getByTestId("review-canvas-tag").textContent()).toBe("Canevas de la page · Carrousel");
  expect(await tab.getByRole("button", { name: "Avant" }).isDisabled()).toBe(true);
  expect(await tab.getByRole("button", { name: "Tweaks" }).count()).toBe(0);
  expect(await tab.getByRole("button", { name: "Habillage" }).count()).toBe(0);
  expect(await tab.getByRole("button", { name: "Repères" }).count()).toBe(1);
  await expect.poll(() => tab.locator('[data-canvas-target="1"]').count()).toBe(1);
  expect(await tab.getByText("Page Carrousel · canevas").count()).toBe(1);
  expect(await tab.getByTestId("review-canvas").getByText("Les 8 candidats sont sur la page des explorations.").count()).toBe(1);
  // The neighbouring artboards are drawn, dimmed.
  expect(await tab.locator("[data-canvas-artboard]").count()).toBeGreaterThanOrEqual(1);

  await tab.close();
});

it("pins the note with Alt + click, draws a zone with Alt + drag, and does nothing on empty canvas or a dimmed artboard", async () => {
  const { reviewId } = await declare();
  const tab = await open(reviewId);
  await expect.poll(() => tab.locator('[data-canvas-target="1"]').count()).toBe(1);
  const frame = await tab.locator('[data-canvas-target="1"]').boundingBox();
  const canvas = (await tab.getByTestId("review-canvas").boundingBox())!;

  // Alt + click on empty canvas and on a dimmed artboard: nothing.
  await tab.keyboard.down("Alt");
  await tab.mouse.click(canvas.x + 12, canvas.y + canvas.height - 12);
  await tab.mouse.click(canvas.x + canvas.width * 0.2, canvas.y + canvas.height * 0.5);
  expect(await tab.locator("[data-pin]").count()).toBe(0);

  // Alt + click on the note pins it.
  await tab.mouse.click(frame!.x + frame!.width / 2, frame!.y + frame!.height / 2);
  await tab.keyboard.up("Alt");
  const dialog = tab.getByRole("dialog", { name: "Épingle 1" });
  await expect.poll(() => dialog.count()).toBe(1);
  await tab.getByRole("textbox", { name: "Ton épingle" }).fill("Mets le lien en bouton");
  await expect.poll(async () => (await reviewOf(reviewId)).steps[0]!.pins.map((pin) => [pin.number, pin.text, pin.target.kind === "canvas-element" ? pin.target.elementId : pin.target.kind])).toEqual([[1, "Mets le lien en bouton", "note-candidats"]]);
  expect(await tab.getByTestId("review-pins-list").textContent()).toContain("Note du canevas");
  await dialog.getByRole("button", { name: "Fermer" }).click();

  // Alt + drag draws a zone in canvas pixels.
  await tab.keyboard.down("Alt");
  await tab.mouse.move(canvas.x + canvas.width * 0.55, canvas.y + canvas.height * 0.75);
  await tab.mouse.down();
  await tab.mouse.move(canvas.x + canvas.width * 0.8, canvas.y + canvas.height * 0.9, { steps: 4 });
  await tab.mouse.up();
  await tab.keyboard.up("Alt");
  await tab.getByRole("textbox", { name: "Ta zone" }).fill("Ajoute une flèche");
  await expect.poll(async () => (await reviewOf(reviewId)).steps[0]!.pins.map((pin) => (pin.target.kind === "zone" && pin.target.space === "canvas" ? [pin.number, pin.target.w > 0 && pin.target.h > 0] : [])).at(1)).toEqual([2, true]);

  await tab.close();
});

it("says the note no longer exists when it was deleted, and the question can still be answered", async () => {
  const { reviewId, pageId } = await declare();
  await seam.server.post(`/api/pages/${pageId}/versions`, { files: FILES([]), message: "Delete the note", origin: "user" });
  const tab = await open(reviewId);

  await expect.poll(() => tab.getByTestId("review-canvas-gone").count()).toBe(1);
  expect(await tab.getByTestId("review-canvas-gone").textContent()).toContain("Cette note n'existe plus");
  await tab.getByRole("button", { name: "OK, étape suivante" }).click();
  await expect.poll(async () => (await reviewOf(reviewId)).steps[0]!.answers.map((answer) => answer.kind)).toEqual(["ok"]);

  await tab.close();
});

it("shows the same crop on a phone, with Épingler", async () => {
  const { reviewId } = await declare();
  const tab = await open(reviewId, { width: 390, height: 844 });

  await expect.poll(() => tab.locator('[data-canvas-target="1"]').count()).toBe(1);
  await tab.getByRole("button", { name: "Épingler" }).click();
  const frame = (await tab.locator('[data-canvas-target="1"]').boundingBox())!;
  await tab.mouse.click(frame.x + frame.width / 2, frame.y + frame.height / 2);
  await expect.poll(() => tab.getByRole("group", { name: "Épingle 1" }).count()).toBe(1);

  await tab.close();
});
