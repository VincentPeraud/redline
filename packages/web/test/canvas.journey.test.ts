import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { build } from "vite";
import { chromium, type Browser, type Locator } from "playwright";
import { afterAll, beforeAll, expect, it } from "vitest";
import { starterPageFiles, type Page } from "@redline/shared";
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

it("lays artboards out from the manifest, shows titles, and zooms and pans with pins following", async () => {
  const project = (await (await server.post("/api/projects", { title: "Acme" })).json()) as { id: string };
  const html = (title: string) => `<!doctype html><body style="margin:0"><h1 style="margin:40px">${title}</h1></body>`;
  const page = (await (
    await server.post(`/api/projects/${project.id}/pages`, {
      title: "Flow",
      files: {
        "cart.html": html("Cart"),
        "pay.html": html("Pay"),
        "manifest.json": JSON.stringify({
          artboards: [
            { file: "cart.html", title: "Cart", width: 400, height: 300, x: 0, y: 0 },
            { file: "pay.html", title: "Pay", width: 300, height: 200, x: 600, y: 100 },
          ],
          elements: [{ text: "Checkout flow", subtitle: "Two screens", x: 0, y: -80 }],
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
  await tab.getByText("Two screens").waitFor();
  expect(await tab.getByText(/artboards · modifiable/).count()).toBe(0);

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

it("pans and zooms with the wheel and trackpad pinch while the cursor is over an artboard", async () => {
  const project = (await (await server.post("/api/projects", { title: "Wheel" })).json()) as { id: string };
  const wheelPage = (await (
    await server.post(`/api/projects/${project.id}/pages`, {
      title: "Wheel page",
      files: {
        "home.html": "<!doctype html><body style=\"margin:0\"><h1>Home</h1></body>",
        "manifest.json": JSON.stringify({ artboards: [{ file: "home.html", width: 600, height: 400, x: 0, y: 0 }] }),
      },
    })
  ).json()) as Page;
  const tab = await browser.newPage({ viewport: { width: 1400, height: 900 } });
  await tab.goto(`${server.url}/#/pages/${wheelPage.id}`);
  const home = tab.locator('iframe[title$="home.html"]');
  await tab.frameLocator('iframe[title$="home.html"]').getByText("Home").waitFor();
  // Wait until the canvas told the bridge to hand the wheel over.
  await tab.waitForTimeout(200);

  const start = await box(home);
  const cursor = { x: start.x + 300, y: start.y + 200 };
  await tab.mouse.move(cursor.x, cursor.y);
  await tab.mouse.wheel(40, 0);
  await expect.poll(async () => (await box(home)).x).toBeCloseTo(start.x - 40, 0);
  await tab.mouse.wheel(0, 30);
  await expect.poll(async () => (await box(home)).y).toBeCloseTo(start.y - 30, 0);

  const panned = await box(home);
  await tab.keyboard.down("Control");
  await tab.mouse.wheel(0, -20);
  await tab.keyboard.up("Control");
  await expect.poll(async () => (await box(home)).width).toBeGreaterThan(600);
  const zoomed = await box(home);
  // Zoom is anchored on the cursor: the artboard point under it stays under it.
  const ratio = zoomed.width / panned.width;
  expect(zoomed.x).toBeCloseTo(cursor.x - (cursor.x - panned.x) * ratio, 0);
  expect(zoomed.y).toBeCloseTo(cursor.y - (cursor.y - panned.y) * ratio, 0);
}, 60_000);

it("still shows every html file side by side when a page has no manifest", async () => {
  const project = (await (await server.post("/api/projects", { title: "Bare" })).json()) as { id: string };
  const barePage = (await (
    await server.post(`/api/projects/${project.id}/pages`, {
      title: "Bare page",
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

it("shows a new page, which has no artboard, as an empty canvas that says what to do", async () => {
  const project = (await (await server.post("/api/projects", { title: "Acme" })).json()) as { id: string };
  const page = (await (
    await server.post(`/api/projects/${project.id}/pages`, { title: "Stories", files: starterPageFiles("Stories") })
  ).json()) as Page;

  const tab = await browser.newPage({ viewport: { width: 1400, height: 900 } });
  await tab.goto(`${server.url}/#/pages/${page.id}`);
  const empty = tab.getByTestId("canvas-empty");
  await empty.getByRole("heading", { name: "Cette page est vide" }).waitFor();
  expect(await empty.textContent()).toContain("panneau Conversations");
  expect(await tab.locator("iframe").count()).toBe(0);
});

it("shrinks a long title down to half then ellipsises it, clamps the subtitle to two lines, and ignores comment clicks on titles", async () => {
  const project = (await (await server.post("/api/projects", { title: "Titles" })).json()) as { id: string };
  const longTitle = "A very long group title that cannot possibly fit within three hundred pixels of canvas width";
  const longSubtitle = "A long subtitle ".repeat(20).trim();
  const page = (await (
    await server.post(`/api/projects/${project.id}/pages`, {
      title: "Long",
      files: {
        "a.html": "<!doctype html><body>A</body>",
        "manifest.json": JSON.stringify({
          artboards: [{ file: "a.html", width: 400, height: 300, x: 0, y: 0 }],
          elements: [
            { kind: "title", text: longTitle, subtitle: longSubtitle, width: 300, x: 0, y: -140 },
            { text: "Short", subtitle: "Fits", x: 0, y: -240 },
          ],
        }),
      },
    })
  ).json()) as Page;

  const tab = await browser.newPage({ viewport: { width: 1400, height: 900 } });
  await tab.goto(`${server.url}/#/pages/${page.id}`);
  const title = tab.locator("[data-canvas-title]").filter({ hasText: "A very long" });
  await title.waitFor();
  const short = tab.locator("[data-canvas-title]").filter({ hasText: "Short" });
  const shortSize = await short.evaluate((el) => parseFloat(getComputedStyle(el).fontSize));
  const longSize = await title.evaluate((el) => parseFloat(getComputedStyle(el).fontSize));
  expect(shortSize).toBe(32);
  expect(longSize).toBe(16);
  const { clipped, lines } = await title.evaluate((el) => ({ clipped: el.scrollWidth > el.clientWidth, lines: Math.round(el.getBoundingClientRect().height / parseFloat(getComputedStyle(el).lineHeight)) }));
  expect(clipped).toBe(true);
  expect(lines).toBe(1);
  expect(await title.getAttribute("title")).toBe(longTitle);
  expect(await short.getAttribute("title")).toBeNull();

  const subtitle = tab.locator("[data-canvas-subtitle]").filter({ hasText: "A long subtitle" });
  const subtitleLines = await subtitle.evaluate((el) => Math.round(el.getBoundingClientRect().height / parseFloat(getComputedStyle(el).lineHeight)));
  expect(subtitleLines).toBe(2);
  expect(await subtitle.getAttribute("title")).toBe(longSubtitle);

  await tab.getByRole("button", { name: "Commenter (C)" }).click();
  await title.click({ force: true });
  expect(await tab.getByLabel("Nouveau commentaire").count()).toBe(0);
  expect(await tab.locator("[data-pin]").count()).toBe(0);
}, 60_000);

it("shows layout guides on the artboards that declare them, from the button or the G key, and remembers the choice", async () => {
  const project = (await (await server.post("/api/projects", { title: "Guides" })).json()) as { id: string };
  const html = "<!doctype html><body style=\"margin:0\"><h1>Hi</h1></body>";
  const guided = (await (
    await server.post(`/api/projects/${project.id}/pages`, {
      title: "Guided",
      files: {
        "a.html": html,
        "b.html": html,
        "manifest.json": JSON.stringify({
          artboards: [
            { file: "a.html", width: 400, height: 300, x: 0, y: 0, guides: { columns: 4, gutter: 8, margin: 16, baseline: 8 } },
            { file: "b.html", width: 400, height: 300, x: 500, y: 0 },
          ],
        }),
      },
    })
  ).json()) as Page;
  const tab = await browser.newPage({ viewport: { width: 1400, height: 900 } });
  await tab.goto(`${server.url}/#/pages/${guided.id}`);
  await tab.locator('iframe[title$="a.html"]').waitFor();
  const columns = tab.locator("[data-guide-column]");
  const toggle = tab.getByRole("button", { name: "Guides (G)" });

  expect(await toggle.getAttribute("aria-pressed")).toBe("false");
  expect(await columns.count()).toBe(0);

  await toggle.click();
  expect(await toggle.getAttribute("aria-pressed")).toBe("true");
  expect(await columns.count()).toBe(4);
  expect(await tab.locator("[data-guide-baseline]").count()).toBe(1);
  const first = await box(columns.first());
  const frame = await box(tab.locator('iframe[title$="a.html"]'));
  expect(first.x - frame.x).toBeCloseTo(16 * (frame.width / 400), 0);

  await tab.reload();
  await tab.locator('iframe[title$="a.html"]').waitFor();
  expect(await columns.count()).toBe(4);

  await tab.locator("body").press("g");
  expect(await columns.count()).toBe(0);
  expect(await toggle.getAttribute("aria-pressed")).toBe("false");
}, 60_000);
