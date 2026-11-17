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
let headers: Record<string, string>;

beforeAll(async () => {
  webDir = mkdtempSync(join(tmpdir(), "redline-web-"));
  copyBuiltWeb(webDir);
  seam = await startSeam2(new FakeEngine(() => []), { webDir });
  browser = await launchBrowser();
  const { token } = (await (await seam.server.get("/api/agent-token")).json()) as AgentTokenResponse;
  headers = { authorization: `Bearer ${token}`, "content-type": "application/json" };
}, 60_000);

afterAll(async () => {
  await browser?.close();
  await seam?.stop();
  rmSync(webDir, { recursive: true, force: true });
});

const HOME = { file: "home.html", title: "Home", x: 0, y: 0, width: 1200, height: 800, frame: "browser" };
const OTHER = { file: "other.html", title: "Other", x: 1300, y: 0, width: 1200, height: 800, frame: "browser" };
const FILES = (title: string) => ({
  "home.html": `<!doctype html><body style="margin:0"><h1 style="margin:40px">${title}</h1><p id="p" style="margin:40px">Body</p>`,
  "other.html": "<!doctype html><h1>Other screen</h1>",
  "manifest.json": JSON.stringify({ artboards: [HOME, OTHER] }),
});
let counter = 0;

/** A review of home.html (with `other.html` grouped when asked), declared by a fresh terminal session. */
async function declare(group = false, rewritten = false): Promise<{ reviewId: string; pageId: string; stepId: string }> {
  const session = `7d6f3f6e-0000-4000-8000-0000000005${String(++counter).padStart(2, "0")}`;
  const page = await seam.createPage(FILES("Old title"), "Site");
  await fetch(`${seam.server.url}/agent-api/terminal-sessions/${session}/heartbeat`, { method: "POST", headers, body: JSON.stringify({ folder: "/work/site", machine: "Mac" }) });
  if (rewritten) {
    // The session rewrote the title before the series: "Avant" has a version to show.
    const current = (await (await seam.server.get(`/api/pages/${page.id}`)).json()) as { version: { id: string } };
    await fetch(`${seam.server.url}/agent-api/pages/${page.id}/versions`, { method: "POST", headers, body: JSON.stringify({ files: FILES("New title"), message: "Rewrite", origin: "terminal", baseVersionId: current.version.id, terminalSessionId: session }) });
  }
  const response = await fetch(`${seam.server.url}/agent-api/terminal-sessions/${session}/reviews`, {
    method: "POST",
    headers,
    body: JSON.stringify({ folder: `/work/${page.id}/site`, steps: [{ pageId: page.id, artboard: "home.html", changed: "c", lookAt: "l", question: "Fine?", ...(group ? { others: [{ pageId: page.id, artboard: "other.html" }] } : {}) }] }),
  });
  const reviewId = ((await response.json()) as { id: string }).id;
  const review = await reviewOf(reviewId);
  return { reviewId, pageId: page.id, stepId: review.steps[0]!.id };
}
const reviewOf = async (reviewId: string) => (await (await fetch(`${seam.server.url}/api/change-reviews/${reviewId}`)).json()) as ChangeReview;
const addPin = (reviewId: string, stepId: string, body: unknown) =>
  fetch(`${seam.server.url}/api/change-reviews/${reviewId}/steps/${stepId}/pins`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
const post = (path: string) => fetch(`${seam.server.url}/api/change-reviews/${path}`, { method: "POST" });
const republish = (pageId: string, files: Record<string, string>) =>
  fetch(`${seam.server.url}/api/pages/${pageId}/versions`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ files, message: "Again", origin: "terminal" }) });
const open = async (reviewId: string): Promise<Page> => {
  const tab = await browser.newPage({ viewport: { width: 1440, height: 900 } });
  await tab.goto(`${seam.server.url}/#/reviews/${reviewId}/steps/1`);
  await expect.poll(() => tab.frameLocator('iframe[title^="Revue /"]').locator("h1").first().textContent()).toBeTruthy();
  return tab;
};
const H1 = { selector: "h1", elementName: "titre « Old title »", xPct: 10, yPct: 10 };

it("hides pins in the Avant view, turns the reminder into a hint, disables Épingler and ignores Alt + click", async () => {
  const { reviewId, stepId } = await declare(false, true);
  await addPin(reviewId, stepId, { text: "Title too small", target: H1 });
  const tab = await open(reviewId);
  await expect.poll(() => tab.locator("[data-pin]").count()).toBe(1);

  await tab.getByTestId("review-top").getByRole("button", { name: "Avant" }).click();

  await expect.poll(() => tab.locator("[data-pin]").count()).toBe(0);
  expect(await tab.getByTestId("review-pin-hint").textContent()).toBe("Vue Avant : repasse sur Après pour épingler");
  expect(await tab.getByRole("button", { name: "Épingler" }).isDisabled()).toBe(true);
  expect(await tab.getByTestId("review-pins-list").textContent()).toContain("Masquée en vue Avant");
  expect(await tab.getByText("Ton épingle remplace ton OK pour cette étape.").count()).toBe(0);
  await tab.frameLocator('iframe[title^="Revue /"]').locator("h1").click({ modifiers: ["Alt"] });
  expect(await tab.getByRole("dialog").count()).toBe(0);
  await tab.close();
});

it("keeps a pin of a grouped step on the artboard where it was placed and lists where to find it", async () => {
  const { reviewId, stepId, pageId } = await declare(true);
  await addPin(reviewId, stepId, { text: "Heading too close", target: { selector: "h1", elementName: "titre « Other screen »", xPct: 10, yPct: 10 }, on: { pageId, artboard: "other.html" } });
  const tab = await open(reviewId);

  const list = tab.getByTestId("review-pins-list");
  await expect.poll(() => list.textContent()).toContain("titre « Other screen » sur Site · Other");
  expect(await tab.locator("[data-pin]").count()).toBe(0);

  await list.getByRole("button", { name: "l'afficher" }).click();
  await expect.poll(() => tab.locator("[data-pin]").count()).toBe(1);
  expect(await tab.getByTestId("review-others").textContent()).toContain("Affiché : Site · Other");
  await tab.close();
});

it("greys a pin whose element is gone after a republish, and says so in the list", async () => {
  const { reviewId, stepId, pageId } = await declare();
  await addPin(reviewId, stepId, { text: "Body unclear", target: { selector: "#p", elementName: "paragraphe « Body »", xPct: 10, yPct: 30 } });
  await republish(pageId, { ...FILES("New title"), "home.html": "<!doctype html><h1>New title</h1>" });
  const tab = await open(reviewId);

  await expect.poll(() => tab.locator("[data-pin]").getAttribute("aria-label")).toContain("élément introuvable");
  await expect.poll(() => tab.getByTestId("review-pins-list").textContent()).toContain("Élément introuvable dans la nouvelle version");
  await tab.close();
});

it("clears the member's pins and remark and records an OK in one call from Effacer mes retours et valider", async () => {
  const { reviewId, stepId, pageId } = await declare();
  await addPin(reviewId, stepId, { text: "Title too small", target: H1 });
  await fetch(`${seam.server.url}/api/change-reviews/${reviewId}/steps/${stepId}/remark`, { method: "PUT", headers: { "content-type": "application/json" }, body: JSON.stringify({ text: "Move it" }) });
  await republish(pageId, FILES("New title"));
  const tab = await open(reviewId);

  const calls: string[] = [];
  tab.on("request", (request) => request.method() !== "GET" && request.url().includes("/api/change-reviews/") && calls.push(`${request.method()} ${new URL(request.url()).pathname.split("/").slice(-1)[0]}`));
  await tab.getByRole("button", { name: "Effacer mes retours et valider" }).click();
  await tab.getByTestId("review-pending").getByRole("button", { name: "Annuler" }).click();
  await tab.waitForTimeout(6_000);
  expect((await reviewOf(reviewId)).steps[0]!.pins).toHaveLength(1);
  expect(calls.filter((call) => !["PUT lost", "POST presence"].includes(call))).toEqual([]);

  await tab.getByRole("button", { name: "Effacer mes retours et valider" }).click();

  await expect.poll(async () => (await reviewOf(reviewId)).steps[0]!.answers.map((answer) => answer.kind), { timeout: 15_000 }).toEqual(["ok"]);
  expect((await reviewOf(reviewId)).steps[0]!.pins).toEqual([]);
  expect(calls.filter((call) => !["PUT lost", "POST presence"].includes(call))).toEqual(["POST clear-and-validate"]);
  await tab.close();
});

it("makes pins read-only when the review is finished and editable again when it is reopened", async () => {
  const { reviewId, stepId } = await declare();
  await addPin(reviewId, stepId, { text: "Title too small", target: H1 });
  const tab = await open(reviewId);
  await expect.poll(() => tab.locator("[data-pin]").count()).toBe(1);
  expect(await tab.getByTestId("review-pin-hint").count()).toBe(1);

  await post(`${reviewId}/finish`);
  await tab.reload();
  await expect.poll(() => tab.locator("[data-pin]").count()).toBe(1);
  expect(await tab.getByTestId("review-pin-hint").count()).toBe(0);
  expect(await tab.getByRole("button", { name: "Modifier" }).count()).toBe(0);
  await tab.frameLocator('iframe[title^="Revue /"]').locator("h1").click({ modifiers: ["Alt"] });
  expect(await tab.getByRole("dialog", { name: /Nouvelle épingle|Épingle 2/ }).count()).toBe(0);

  await post(`${reviewId}/reopen`);
  await expect.poll(() => tab.getByRole("button", { name: "Modifier" }).count()).toBe(1);
  await tab.close();
});

it("pins an element with Épingler and a plain click, then leaves the pick mode", async () => {
  const { reviewId } = await declare();
  const tab = await open(reviewId);

  await tab.getByRole("button", { name: "Épingler" }).click();
  expect(await tab.getByTestId("review-pin-hint").textContent()).toContain("Clique sur l'élément à épingler");
  await tab.frameLocator('iframe[title^="Revue /"]').locator("#p").click();

  await expect.poll(() => tab.getByRole("dialog", { name: "Épingle 1" }).count()).toBe(1);
  expect(await tab.getByTestId("review-pin-hint").textContent()).toContain("Alt");
  await tab.close();
});

it("saves and closes an open pin panel when another artboard of the group is opened", async () => {
  const { reviewId } = await declare(true);
  const tab = await open(reviewId);
  await tab.frameLocator('iframe[title^="Revue /"]').locator("h1").click({ modifiers: ["Alt"] });
  await tab.getByRole("textbox", { name: "Ton épingle" }).fill("Typed then switched");
  await tab.getByRole("button", { name: /Other/ }).first().click();

  await expect.poll(() => tab.getByRole("dialog").count()).toBe(0);
  await expect.poll(async () => (await reviewOf(reviewId)).steps[0]!.pins.map((pin) => pin.text)).toEqual(["Typed then switched"]);
  await tab.close();
});

it("saves a pin placed from the screen on another artboard of the group on that artboard", async () => {
  const { reviewId, pageId } = await declare(true);
  const tab = await open(reviewId);
  await tab.getByRole("button", { name: /Other/ }).first().click();
  await expect.poll(() => tab.frameLocator('iframe[title^="Revue /"]').locator("h1").first().textContent()).toBe("Other screen");

  await tab.frameLocator('iframe[title^="Revue /"]').locator("h1").click({ modifiers: ["Alt"] });
  await tab.getByRole("textbox", { name: "Ton épingle" }).fill("On the other screen");

  await expect.poll(async () => (await reviewOf(reviewId)).steps[0]!.pins).toMatchObject([{ text: "On the other screen", on: { pageId, artboard: "other.html" } }]);
  await tab.close();
});

