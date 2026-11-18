import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { copyBuiltWeb } from "./builtWeb.js";
import { type Browser } from "playwright";
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

const MANIFEST = JSON.stringify({
  artboards: [
    { file: "tall.html", title: "Tall", x: 0, y: 0, width: 390, height: 2400 },
    { file: "wide.html", title: "Wide", x: 500, y: 0, width: 1800, height: 3000 },
    { file: "short.html", title: "Short", x: 2400, y: 0, width: 800, height: 500 },
    { file: "slide.html", title: "Slide", x: 3400, y: 0, width: 1080, height: 1350 },
    { file: "list.html", title: "List", x: 4600, y: 0, width: 800, height: 500 },
  ],
});
const page = (height: number) => `<!doctype html><body style="margin:0"><h1>Top</h1><div id="pricing" style="margin-top:${height / 2}px;height:80px">Pricing</div></body>`;
const LIST = `<!doctype html><body style="margin:0"><div id="list" style="height:300px;margin-top:50px;overflow:auto"><div style="height:200px"></div><div id="row" style="height:80px">Row</div><div style="height:800px"></div></div></body>`;
const FILES = { "tall.html": page(2400), "wide.html": page(3000), "short.html": page(500), "slide.html": page(1350), "list.html": LIST, "manifest.json": MANIFEST };
const SESSION = "7d6f3f6e-0000-4000-8000-000000000011";

async function declare(steps: (pageId: string) => Record<string, unknown>[]): Promise<{ reviewId: string; pageId: string }> {
  const created = await seam.createPage(FILES, "Home");
  const { token } = (await (await seam.server.get("/api/agent-token")).json()) as AgentTokenResponse;
  const headers = { authorization: `Bearer ${token}`, "content-type": "application/json" };
  await fetch(`${seam.server.url}/agent-api/terminal-sessions/${SESSION}/heartbeat`, { method: "POST", headers, body: JSON.stringify({ folder: "/work/site", machine: "Mac" }) });
  const response = await fetch(`${seam.server.url}/agent-api/terminal-sessions/${SESSION}/reviews`, {
    method: "POST",
    headers,
    body: JSON.stringify({ folder: `/work/${created.id}/site`, steps: steps(created.id) }),
  });
  return { reviewId: ((await response.json()) as { id: string }).id, pageId: created.id };
}

const step = (pageId: string, artboard: string, extra: Record<string, unknown> = {}) => ({ pageId, artboard, changed: `The ${artboard} changed`, lookAt: `Look at ${artboard}`, question: `Is ${artboard} fine?`, ...extra });

it("shows a tall artboard at its real width in review, scrolled to Claude's first frame, and keeps the fit of a short one", async () => {
  const { reviewId } = await declare((id) => [step(id, "tall.html", { targets: ["#pricing"] }), step(id, "wide.html"), step(id, "short.html")]);
  const tab = await browser.newPage({ viewport: { width: 1440, height: 900 } });
  await tab.goto(`${seam.server.url}/#/reviews/${reviewId}/steps/1`);

  const stage = tab.getByLabel("Artboard, fais défiler pour tout voir");
  await stage.waitFor();
  const frame = tab.locator(`iframe[title="Revue / tall.html"]`);
  expect((await frame.boundingBox())!.width).toBeCloseTo(390, 0);
  expect(await tab.getByTestId("review-scroll-tag").textContent()).toBe("Taille réelle · 390 × 2400 · fais défiler");
  await expect.poll(() => stage.evaluate((node) => node.scrollTop)).toBeGreaterThan(800);

  // The scroll position survives a re-render of the stage.
  const scrolled = await stage.evaluate((node) => node.scrollTop);
  await tab.getByRole("button", { name: "Repères" }).click();
  expect(await stage.evaluate((node) => node.scrollTop)).toBe(scrolled);

  await tab.getByRole("button", { name: "Suivante →" }).click();
  await expect.poll(() => tab.getByTestId("review-scroll-tag").textContent()).toMatch(/^Pleine largeur · 1800 × 3000/);
  const wide = tab.locator(`iframe[title="Revue / wide.html"]`);
  const stageBox = (await stage.boundingBox())!;
  expect((await wide.boundingBox())!.width).toBeLessThan(stageBox.width);

  await tab.getByRole("button", { name: "Suivante →" }).click();
  await expect.poll(() => tab.getByTestId("review-scroll-tag").count()).toBe(0);
  await tab.close();
}, 60_000);

it("shows a tall artboard at its real width in Present, with a vertical scroll", async () => {
  const created = await seam.createPage(FILES, "Present");
  const tab = await browser.newPage({ viewport: { width: 1440, height: 900 } });
  await tab.goto(`${seam.server.url}/#/pages/${created.id}/play/tall.html`);

  const play = tab.getByTestId("play");
  await play.waitFor();
  const frame = tab.locator(`iframe[title="Plein écran / tall.html"]`);
  await expect.poll(async () => (await frame.boundingBox())?.width).toBeCloseTo(390, 0);
  await expect.poll(() => play.locator("main").evaluate((node) => node.scrollHeight > node.clientHeight)).toBe(true);
  expect(await play.textContent()).toContain("Taille réelle · 390 × 2400 · fais défiler");
  await tab.close();
}, 60_000);

it("opens a slide a little taller than the stage fitted, a long page at its width, and zooms them with the bar", async () => {
  const { reviewId } = await declare((id) => [step(id, "tall.html"), step(id, "slide.html")]);
  const tab = await browser.newPage({ viewport: { width: 1440, height: 900 } });
  await tab.goto(`${seam.server.url}/#/reviews/${reviewId}/steps/1`);

  // A long page still opens at its width, to scroll, and can be fitted.
  const bar = tab.getByTestId("review-artboard-zoom");
  await bar.waitFor();
  await expect.poll(() => tab.getByTestId("review-scroll-tag").textContent()).toBe("Taille réelle · 390 × 2400 · fais défiler");
  await bar.getByRole("button", { name: "Ajuster" }).click();
  await expect.poll(() => tab.getByTestId("review-scroll-tag").count()).toBe(0);

  await tab.getByRole("button", { name: "Suivante →" }).click();
  const frame = tab.locator(`iframe[title="Revue / slide.html"]`);
  await frame.waitFor();
  // Fitted: the whole slide in the stage, no scroll.
  await expect.poll(() => bar.getByRole("button", { name: "Ajuster" }).getAttribute("aria-pressed")).toBe("true");
  expect(await tab.getByTestId("review-scroll-tag").count()).toBe(0);
  const fitted = (await frame.boundingBox())!.height;
  expect(fitted).toBeLessThan(900);

  await bar.getByRole("button", { name: "100 %" }).click();
  await expect.poll(() => tab.getByTestId("review-scroll-tag").textContent()).toBe("100 % · 1080 × 1350 · fais défiler");
  expect((await frame.boundingBox())!.height).toBeCloseTo(1350, 0);

  await bar.getByRole("button", { name: "Dézoomer" }).click();
  await expect.poll(async () => (await frame.boundingBox())!.height).toBeCloseTo(1080, 0);
  expect(await bar.getByTitle("Revenir au cadrage de l'étape").textContent()).toBe("80 %");

  // The % goes back to how the step opened.
  await bar.getByTitle("Revenir au cadrage de l'étape").click();
  await expect.poll(async () => (await frame.boundingBox())!.height).toBeCloseTo(fitted, 0);
  await tab.close();
}, 60_000);

it("moves the frame of a target with the list it scrolls in, and drops it once the row is out", async () => {
  const { reviewId } = await declare((id) => [step(id, "list.html", { targets: ["#row"] })]);
  const tab = await browser.newPage({ viewport: { width: 1440, height: 900 } });
  await tab.goto(`${seam.server.url}/#/reviews/${reviewId}/steps/1`);

  const inner = tab.frameLocator(`iframe[title="Revue / list.html"]`);
  const outline = inner.locator("#__redline-compare [data-part=outline]");
  await expect.poll(() => outline.evaluate((node) => (node as HTMLElement).style.top)).toBe("245px");
  await inner.locator("#list").evaluate((node) => (node.scrollTop = 100));
  await expect.poll(() => outline.evaluate((node) => (node as HTMLElement).style.top)).toBe("145px");
  await inner.locator("#list").evaluate((node) => (node.scrollTop = 400));
  await expect.poll(() => outline.count()).toBe(0);
  await tab.close();
}, 60_000);
