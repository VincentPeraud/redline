import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { build } from "vite";
import { chromium, type Browser, type Locator } from "playwright";
import { afterAll, beforeAll, expect, it } from "vitest";
import type { Page } from "@redline/shared";
import { startTestServer, type TestServer } from "@redline/server/test-harness";

const webRoot = fileURLToPath(new URL("..", import.meta.url));

let server: TestServer;
let browser: Browser;
let webDir: string;

beforeAll(async () => {
  webDir = mkdtempSync(join(tmpdir(), "redline-web-"));
  await build({ root: webRoot, logLevel: "silent", build: { outDir: webDir, emptyOutDir: true } });
  server = await startTestServer({ webDir });
  browser = await chromium.launch();
}, 60_000);

afterAll(async () => {
  await browser?.close();
  await server?.stop();
  rmSync(webDir, { recursive: true, force: true });
});

async function box(locator: Locator) {
  const result = await locator.boundingBox();
  if (!result) throw new Error("element has no box");
  return result;
}

it("lays artboards out from the manifest, shows notes, and zooms and pans with pins following", async () => {
  const project = (await (await server.post("/api/projects", { title: "Acme" })).json()) as { id: string };
  const html = (title: string) => `<!doctype html><body style="margin:0"><h1 style="margin:40px">${title}</h1></body>`;
  const page = (await (
    await server.post(`/api/projects/${project.id}/pages`, {
      title: "Flow",
      type: "prototype",
      files: {
        "cart.html": html("Cart"),
        "pay.html": html("Pay"),
        "manifest.json": JSON.stringify({
          artboards: [
            { file: "cart.html", title: "Cart", width: 400, height: 300, x: 0, y: 0 },
            { file: "pay.html", title: "Pay", width: 300, height: 200, x: 600, y: 100 },
          ],
          notes: [{ text: "Checkout flow", x: 0, y: -80 }],
        }),
      },
    })
  ).json()) as Page;
  await server.post(`/api/pages/${page.id}/threads`, {
    artboard: "pay.html",
    selector: "h1",
    xPct: 20,
    yPct: 30,
    body: "Make this bigger",
  });

  const tab = await browser.newPage({ viewport: { width: 1400, height: 900 } });
  await tab.goto(`${server.url}/#/pages/${page.id}`);
  const cart = tab.locator('iframe[title$="cart.html"]');
  const pay = tab.locator('iframe[title$="pay.html"]');
  await tab.getByText("Checkout flow").waitFor();

  const cartBox = await box(cart);
  const payBox = await box(pay);
  expect([cartBox.width, cartBox.height]).toEqual([400, 300]);
  expect([payBox.width, payBox.height]).toEqual([300, 200]);
  expect(payBox.x - cartBox.x).toBe(600);
  expect(payBox.y - cartBox.y).toBe(100);

  const pin = tab.locator('[data-pin="1"]');
  await pin.waitFor();
  const relativePin = async () => {
    const p = await box(pin);
    const f = await box(pay);
    return { x: (p.x + p.width / 2 - f.x) / f.width, y: (p.y + p.height / 2 - f.y) / f.height };
  };
  await expect.poll(async () => Math.round((await relativePin()).x * 100)).toBeGreaterThan(0);
  const before = await relativePin();

  await tab.getByRole("button", { name: "Zoomer", exact: true }).click();
  await expect.poll(async () => (await box(cart)).width).toBeGreaterThan(400);
  const zoomedPay = await box(pay);
  expect(zoomedPay.width).toBeGreaterThan(300);
  const afterZoom = await relativePin();
  expect(afterZoom.x).toBeCloseTo(before.x, 2);
  expect(afterZoom.y).toBeCloseTo(before.y, 2);

  const canvas = tab.getByTestId("canvas");
  const canvasBox = await box(canvas);
  const start = { x: canvasBox.x + 400, y: canvasBox.y + canvasBox.height - 120 };
  const panStart = await box(cart);
  await tab.mouse.move(start.x, start.y);
  await tab.mouse.down();
  await tab.mouse.move(start.x + 50, start.y - 30, { steps: 4 });
  await tab.mouse.up();
  const panned = await box(cart);
  expect(panned.x - panStart.x).toBeCloseTo(50, 0);
  expect(panned.y - panStart.y).toBeCloseTo(-30, 0);
  const afterPan = await relativePin();
  expect(afterPan.x).toBeCloseTo(before.x, 2);
}, 60_000);

it("still shows every html file side by side when a page has no manifest", async () => {
  const project = (await (await server.post("/api/projects", { title: "Bare" })).json()) as { id: string };
  const barePage = (await (
    await server.post(`/api/projects/${project.id}/pages`, {
      title: "Bare page",
      type: "comparison",
      files: { "one.html": "<!doctype html><h1>One</h1>", "two.html": "<!doctype html><h1>Two</h1>" },
    })
  ).json()) as Page;
  const tab = await browser.newPage({ viewport: { width: 1400, height: 900 } });
  await tab.goto(`${server.url}/#/pages/${barePage.id}`);
  const one = await box(tab.locator('iframe[title$="one.html"]'));
  const two = await box(tab.locator('iframe[title$="two.html"]'));
  expect(two.x).toBeGreaterThan(one.x + one.width);
  expect(two.y).toBe(one.y);
}, 60_000);

it("is interactive by default, pins with C or Alt+click, and returns to interactive with P", async () => {
  const project = (await (await server.post("/api/projects", { title: "Modes" })).json()) as { id: string };
  const modesPage = (await (
    await server.post(`/api/projects/${project.id}/pages`, {
      title: "Modes page",
      type: "prototype",
      files: {
        "app.html": `<!doctype html><body style="margin:0"><button id="go" style="margin:40px;width:120px;height:40px" onclick="this.textContent='Clicked'">Go</button></body>`,
      },
    })
  ).json()) as Page;
  const tab = await browser.newPage({ viewport: { width: 1400, height: 900 } });
  await tab.goto(`${server.url}/#/pages/${modesPage.id}`);
  const section = tab;
  const button = section.frameLocator('iframe[title$="app.html"]').locator("#go");
  const mode = section.getByTestId("mode-indicator");
  const draft = section.getByText("Commentaire sur");
  const cancel = section.getByRole("button", { name: "Annuler" });
  await button.waitFor();
  await expect.poll(async () => (await mode.textContent())?.includes("Canvas interactif")).toBe(true);

  await new Promise((resolve) => setTimeout(resolve, 300));
  await button.click();
  await expect.poll(() => button.textContent()).toBe("Clicked");
  expect(await draft.count()).toBe(0);

  await button.click({ modifiers: ["Alt"] });
  await draft.waitFor();
  expect(await mode.textContent()).toContain("Canvas interactif");
  await cancel.click();

  await tab.keyboard.press("c");
  expect(await mode.textContent()).toContain("Mode commentaire");
  await button.click();
  await draft.waitFor();
  await cancel.click();
  expect(await mode.textContent()).toContain("Mode commentaire");

  await tab.keyboard.press("p");
  expect(await mode.textContent()).toContain("Canvas interactif");
}, 60_000);
