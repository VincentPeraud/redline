import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { copyBuiltWeb } from "./builtWeb.js";
import { type Browser, type Page } from "playwright";
import { launchBrowser } from "./journeyBrowser.js";
import { afterAll, beforeAll, expect, it } from "vitest";
import { FakeEngine, startSeam2, type Seam2 } from "@redline/agent/seam2";
import type { AgentTokenResponse } from "@redline/shared";

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

// A page much taller than its 1200 × 800 window: it scrolls inside the iframe.
const MANIFEST = JSON.stringify({ artboards: [{ file: "long.html", title: "Long", x: 0, y: 0, width: 1200, height: 800, frame: "browser" }] });
const HTML = `<!doctype html><body style="margin:0"><div style="height:1200px"></div><h2 id="far" style="margin:0 0 0 200px;width:300px;height:60px">Loin en bas</h2><div style="height:1200px"></div></body>`;

async function declareReview(): Promise<string> {
  const folder = "/work/scrolled";
  const page = await seam.createPage({ "long.html": HTML, "manifest.json": MANIFEST }, "Home");
  const { token } = (await (await seam.server.get("/api/agent-token")).json()) as AgentTokenResponse;
  const session = "7d6f3f6e-0000-4000-8000-000000000031";
  await fetch(`${seam.server.url}/agent-api/terminal-sessions/${session}/heartbeat`, { method: "POST", headers: { authorization: `Bearer ${token}`, "content-type": "application/json" }, body: JSON.stringify({ folder, machine: "Mac" }) });
  const response = await fetch(`${seam.server.url}/agent-api/terminal-sessions/${session}/reviews`, {
    method: "POST",
    headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
    body: JSON.stringify({ folder, steps: [{ pageId: page.id, artboard: "long.html", changed: "c", lookAt: "l", question: "Is the long page fine?" }] }),
  });
  return ((await response.json()) as { id: string }).id;
}

const box = async (tab: Page, selector: string) => (await tab.locator(selector).first().boundingBox())!;
/** The heading's box on screen, from the iframe's box and the heading's place in it (the iframe is scaled down). */
async function farBox(tab: Page) {
  const frameBox = (await tab.locator("iframe").boundingBox())!;
  const inner = await tab.frameLocator("iframe").locator("body").evaluate(() => ({ w: innerWidth, r: document.getElementById("far")!.getBoundingClientRect().toJSON() as DOMRect }));
  const scale = frameBox.width / inner.w;
  return { x: frameBox.x + inner.r.x * scale, y: frameBox.y + inner.r.y * scale, width: inner.r.width * scale, height: inner.r.height * scale, scale };
}
const scrollFrame = (tab: Page, y: number) => tab.frameLocator("iframe").locator("body").evaluate((_, top) => window.scrollTo(0, top), y);

it("keeps pins and zones on what was clicked or drawn in an artboard scrolled inside its window, and moves them with the scroll", async () => {
  const reviewId = await declareReview();
  const tab = await browser.newPage({ viewport: { width: 1440, height: 900 } });
  await tab.goto(`${seam.server.url}/#/reviews/${reviewId}/steps/1`);
  await expect.poll(() => tab.frameLocator("iframe").locator("#far").textContent()).toBe("Loin en bas");
  // The stage fits the artboard once it has loaded: measure it when it stops moving.
  let last = await box(tab, "iframe");
  await expect.poll(async () => {
    const before = last;
    await tab.waitForTimeout(150);
    last = await box(tab, "iframe");
    return before.width === last.width && before.x === last.x && before.y === last.y;
  }).toBe(true);
  await scrollFrame(tab, 900);

  // Alt + click: the pin sits on the clicked heading's top-right corner, where the screen shows it.
  const heading = await farBox(tab);
  await tab.keyboard.down("Alt");
  await tab.mouse.click(heading.x + 20, heading.y + 20);
  await tab.keyboard.up("Alt");
  await tab.getByRole("dialog", { name: "Épingle 1" }).waitFor();
  // Typed with the keyboard: Playwright's fill() would scroll the stage sideways to show the field and skew the measures.
  await tab.keyboard.type("Trop loin");
  // Closing right away (before the pause that saves) keeps one pin, not two.
  // dispatchEvent: Playwright's click() would also scroll the stage sideways to show the button.
  await tab.getByRole("dialog", { name: "Épingle 1" }).getByRole("button", { name: "Fermer" }).dispatchEvent("click");
  await tab.waitForTimeout(400);
  expect(await tab.locator("[data-pin]").count()).toBe(1);
  await expect.poll(async () => { const pin = await box(tab, '[data-pin="1"]'); return Math.abs(pin.y + pin.height / 2 - heading.y) < 4 && Math.abs(pin.x + pin.width / 2 - (heading.x + heading.width)) < 4; }).toBe(true);

  // Scrolling the artboard carries the pin with its heading.
  await scrollFrame(tab, 1000);
  const moved = await farBox(tab);
  expect(Math.round(heading.y - moved.y)).toBeGreaterThan(50);
  await expect.poll(async () => { const pin = await box(tab, '[data-pin="1"]'); return Math.abs(pin.y + pin.height / 2 - moved.y) < 4; }).toBe(true);

  // Alt + drag: the zone covers the rectangle dragged on screen.
  const from = { x: moved.x + 300, y: moved.y + 100 };
  const to = { x: from.x + 200, y: from.y + 100 };
  await tab.keyboard.down("Alt");
  await tab.mouse.move(from.x, from.y);
  await tab.mouse.down();
  await tab.mouse.move((from.x + to.x) / 2, (from.y + to.y) / 2, { steps: 4 });
  await tab.mouse.move(to.x, to.y, { steps: 4 });
  await tab.mouse.up();
  await tab.keyboard.up("Alt");
  await tab.getByRole("dialog", { name: "Zone 2" }).waitFor();
  await tab.keyboard.type("Zone ici");
  const zone = await box(tab, '[data-zone="2"]');
  expect(Math.abs(zone.x - from.x)).toBeLessThan(4);
  expect(Math.abs(zone.y - from.y)).toBeLessThan(4);
  expect(Math.abs(zone.width - 200)).toBeLessThan(6);
  expect(Math.abs(zone.height - 100)).toBeLessThan(6);

  // And the zone scrolls with the page too.
  await scrollFrame(tab, 800);
  await expect.poll(async () => Math.abs((await box(tab, '[data-zone="2"]')).y - (from.y + 200 * moved.scale))).toBeLessThan(4);
  await tab.screenshot({ path: "/tmp/rl-scrolled.png" });
  await tab.close();
}, 60_000);
