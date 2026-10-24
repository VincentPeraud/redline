import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { build } from "vite";
import { chromium, type Browser } from "playwright";
import { afterAll, beforeAll, expect, it } from "vitest";
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

it("plays a prototype: one artboard at full size, links switch artboard, exit returns to the canvas", async () => {
  const project = (await (await server.post("/api/projects", { title: "Shop" })).json()) as { id: string };
  const html = (title: string, body = "") =>
    `<!doctype html><body style="margin:0"><h1>${title}</h1>${body}</body>`;
  const page = (await server.post(`/api/projects/${project.id}/pages`, {
    title: "Checkout",
    files: {
      "cart.html": html("Cart", '<button id="pay" style="width:100px;height:40px">Pay</button><button id="dead">Nothing</button>'),
      "done.html": html("Thanks", '<button id="back">Back</button>'),
      "manifest.json": JSON.stringify({
        artboards: [
          { file: "cart.html", title: "Cart", width: 400, height: 300, x: 0, y: 0 },
          { file: "done.html", title: "Done", width: 360, height: 240, x: 600, y: 0 },
        ],
        links: [
          { from: "cart.html", selector: "#pay", to: "done.html" },
          { from: "done.html", selector: "#back", to: "cart.html" },
        ],
      }),
    },
  }).then((res) => res.json())) as { id: string };

  const tab = await browser.newPage({ viewport: { width: 1400, height: 900 } });
  await tab.goto(`${server.url}/#/pages/${page.id}`);
  await tab.locator('iframe[title$="cart.html"]').waitFor();
  await tab.getByRole("button", { name: "Lancer cart.html en plein écran" }).click();

  const play = tab.getByTestId("play");
  const frame = play.locator("iframe");
  await expect.poll(() => frame.getAttribute("title")).toMatch(/cart\.html$/);
  const size = await frame.boundingBox();
  expect([size?.width, size?.height]).toEqual([400, 300]);
  expect(await tab.locator("iframe").count()).toBe(1);

  const inner = tab.frameLocator('[data-testid="play"] iframe');
  await inner.locator("#dead").click();
  await expect.poll(() => frame.getAttribute("title")).toMatch(/cart\.html$/);

  await inner.locator("#pay").click();
  await expect.poll(() => frame.getAttribute("title")).toMatch(/done\.html$/);
  const next = await frame.boundingBox();
  expect([next?.width, next?.height]).toEqual([360, 240]);

  await inner.locator("#back").click();
  await expect.poll(() => frame.getAttribute("title")).toMatch(/cart\.html$/);

  await tab.getByRole("button", { name: /Canvas/ }).click();
  await expect.poll(() => play.count()).toBe(0);
  await tab.locator('iframe[title$="cart.html"]').waitFor();
  await tab.locator('iframe[title$="done.html"]').waitFor();
}, 60_000);

it("presents each artboard by its declared device, inferring a phone when none is declared", async () => {
  const project = (await (await server.post("/api/projects", { title: "Devices" })).json()) as { id: string };
  const html = `<!doctype html><body style="margin:0"><h1>Hi</h1></body>`;
  const page = (await server.post(`/api/projects/${project.id}/pages`, {
    title: "Devices",
    files: {
      "a.html": html,
      "b.html": html,
      "c.html": html,
      "d.html": html,
      "e.html": html,
      "f.html": html,
      "manifest.json": JSON.stringify({
        artboards: [
          { file: "a.html", width: 390, height: 844, device: "phone" },
          { file: "b.html", width: 576, height: 746, device: "tablet" },
          { file: "c.html", width: 1440, height: 900, device: "desktop", url: "lumora.fr" },
          { file: "d.html", width: 576, height: 814, device: "paper" },
          { file: "e.html", width: 400, height: 300, device: "none" },
          { file: "f.html", width: 390, height: 844 },
        ],
      }),
    },
  }).then((res) => res.json())) as { id: string };

  const tab = await browser.newPage({ viewport: { width: 1440, height: 900 } });
  await tab.goto(`${server.url}/#/pages/${page.id}`);
  await tab.locator('iframe[title$="a.html"]').waitFor();
  await tab.getByRole("button", { name: "Lancer a.html en plein écran" }).click();
  const play = tab.getByTestId("play");

  const expected = ["phone", "tablet", "desktop", "paper", "none", "phone"];
  for (const [index, name] of expected.entries()) {
    await play.getByRole("button", { name: `Artboard ${index + 1}` }).click();
    await expect.poll(() => play.locator("main").getAttribute("data-device")).toBe(name);
    expect(await play.locator("main [data-device]").getAttribute("data-device")).toBe(name);
  }

  await play.getByRole("button", { name: "Artboard 3" }).click();
  await expect.poll(() => play.locator("main").getAttribute("data-device")).toBe("desktop");
  expect(await play.getByText("lumora.fr").count()).toBe(1);
  await tab.close();
}, 60_000);

it("fills the window with a fluid artboard, ignores fill on a phone, and toggles guides in play mode", async () => {
  const project = (await (await server.post("/api/projects", { title: "Fill" })).json()) as { id: string };
  const html = `<!doctype html><body style="margin:0"><h1>Hi</h1></body>`;
  const page = (await server.post(`/api/projects/${project.id}/pages`, {
    title: "Fill",
    files: {
      "dash.html": html,
      "phone.html": html,
      "manifest.json": JSON.stringify({
        artboards: [
          { file: "dash.html", width: 1000, height: 600, device: "desktop", expand: "fill", guides: { columns: 12, gutter: 24, margin: 80 } },
          { file: "phone.html", width: 390, height: 844, device: "phone", expand: "fill" },
        ],
      }),
    },
  }).then((res) => res.json())) as { id: string };

  const tab = await browser.newPage({ viewport: { width: 1440, height: 900 } });
  await tab.goto(`${server.url}/#/pages/${page.id}`);
  const canvasFrame = await tab.locator('iframe[title$="dash.html"]').boundingBox();
  expect(canvasFrame!.width).toBeLessThan(1000);
  await tab.getByRole("button", { name: "Lancer dash.html en plein écran" }).click();
  const play = tab.getByTestId("play");
  const stage = play.locator("main");
  const frame = play.locator("iframe");
  await expect.poll(async () => (await frame.boundingBox())?.width).toBe((await stage.boundingBox())!.width);
  expect((await frame.boundingBox())!.height).toBe((await stage.boundingBox())!.height);

  const columns = play.locator("[data-guide-column]");
  expect(await columns.count()).toBe(0);
  await play.getByRole("button", { name: "Guides (G)" }).click();
  expect(await columns.count()).toBe(12);
  await tab.reload();
  await tab.getByRole("button", { name: "Lancer dash.html en plein écran" }).click();
  expect(await columns.count()).toBe(12);
  await tab.locator("body").press("g");
  expect(await columns.count()).toBe(0);

  await play.getByRole("button", { name: "Artboard 2" }).click();
  await expect.poll(() => play.locator("main").getAttribute("data-device")).toBe("phone");
  expect((await frame.boundingBox())!.width).toBeCloseTo(390, 0);
  await tab.close();
}, 60_000);
