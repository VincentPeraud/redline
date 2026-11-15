import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { copyBuiltWeb } from "./builtWeb.js";
import { type Browser, type Locator } from "playwright";
import { launchBrowser } from "./journeyBrowser.js";
import { afterAll, beforeAll, expect, it } from "vitest";
import { FakeEngine, startSeam2, type Seam2 } from "@redline/agent/seam2";

let browser: Browser;
let webDir: string;
let seam: Seam2;
let answer = "";
const engine = new FakeEngine(() => [{ type: "result", summary: answer }]);

beforeAll(async () => {
  webDir = mkdtempSync(join(tmpdir(), "redline-web-"));
  copyBuiltWeb(webDir);
  seam = await startSeam2(engine, { webDir });
  browser = await launchBrowser();
}, 60_000);

afterAll(async () => {
  await browser?.close();
  await seam?.stop();
  rmSync(webDir, { recursive: true, force: true });
});

const html = `<!doctype html><body style="margin:0"><h1>Hi</h1></body>`;

function manifestOf(...artboards: { file: string; title: string; x: number; y: number }[]) {
  return JSON.stringify({ artboards: artboards.map((a) => ({ ...a, width: 400, height: 300 })) });
}

async function box(locator: Locator) {
  const result = await locator.boundingBox();
  if (!result) throw new Error("element has no box");
  return result;
}

it("shows addresses of this server as pills that centre, navigate or open play mode, strikes a missing artboard, and keeps foreign URLs as links", async () => {
  const flow = await seam.createPage(
    { "near.html": html, "far.html": html, "manifest.json": manifestOf({ file: "near.html", title: "Accueil", x: 0, y: 0 }, { file: "far.html", title: "Disponibilités", x: 3000, y: 1500 }) },
    "Onboarding",
  );
  const checkout = await seam.createPage({ "panier.html": html, "manifest.json": manifestOf({ file: "panier.html", title: "Panier", x: 0, y: 0 }) }, "Checkout");
  const base = seam.server.url;
  answer = [
    `Voir ${base}/#/pages/${flow.id}/artboards/far.html,`,
    `${base}/#/pages/${checkout.id}/artboards/panier.html,`,
    `${base}/#/pages/${flow.id}/play/far.html?rendu=mobile,`,
    `${base}/#/pages/${checkout.id},`,
    `${base}/#/pages/${flow.id}/artboards/ancien.html`,
    `et https://example.com/doc.`,
  ].join(" ");

  const tab = await browser.newPage({ viewport: { width: 1440, height: 900 } });
  await tab.goto(`${base}/#/pages/${flow.id}`);
  const panel = tab.getByTestId("conversations");
  await panel.getByLabel("Message à Claude").fill("Montre-moi");
  await panel.getByLabel("Message à Claude").press("Enter");
  await engine.finished(1);

  const pills = panel.getByTestId("address-pill");
  await expect.poll(async () => (await pills.allTextContents()).map((text) => text.replace("·", "· "))).toEqual([
    "Artboard · Disponibilités",
    "Checkout · Panier",
    "Artboard · Disponibilités",
    "Page · Checkout",
    "Artboard · ancien.html",
  ]);
  const link = panel.getByRole("link", { name: "https://example.com/doc" });
  expect(await link.getAttribute("href")).toBe("https://example.com/doc");
  expect(await pills.nth(4).getAttribute("data-missing")).toBe("true");
  expect(await pills.nth(0).getAttribute("data-missing")).toBeNull();
  expect(await pills.nth(4).locator("span").last().evaluate((el) => getComputedStyle(el).textDecorationLine)).toBe("line-through");
  expect(await tab.getByTestId("message-chips").count()).toBe(0);

  const hashBefore = await tab.evaluate(() => window.location.hash);
  await pills.nth(0).click();
  const viewport = await box(tab.getByTestId("canvas"));
  const frame = () => box(tab.locator('[data-artboard="far.html"] iframe'));
  await expect.poll(async () => Math.abs((await frame()).x + (await frame()).width / 2 - (viewport.x + viewport.width / 2)) < 3).toBe(true);
  expect(await tab.evaluate(() => window.location.hash)).toBe(hashBefore);

  await pills.nth(4).click();
  await tab.getByRole("status").filter({ hasText: "Cet artboard n'existe plus · ancien.html" }).waitFor();

  await pills.nth(2).click();
  await expect.poll(() => tab.evaluate(() => window.location.hash)).toBe(`#/pages/${flow.id}/play/far.html?rendu=mobile`);

  await tab.goBack();
  await pills.nth(1).click();
  await expect.poll(() => tab.evaluate(() => window.location.hash)).toBe(`#/pages/${checkout.id}/artboards/panier.html`);
  await tab.close();
}, 60_000);
