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

it("removes the device frame with Habillage (remembered), and fills the screen without a frame on a narrow window", async () => {
  const project = (await (await server.post("/api/projects", { title: "Habillage" })).json()) as { id: string };
  const html = `<!doctype html><body style="margin:0"><h1>Hi</h1></body>`;
  const page = (await server.post(`/api/projects/${project.id}/pages`, {
    title: "Habillage",
    files: {
      "phone.html": html,
      "desk.html": html,
      "plain.html": html,
      "manifest.json": JSON.stringify({
        title: "Onboarding",
        artboards: [
          { file: "phone.html", width: 390, height: 844, device: "phone" },
          { file: "desk.html", width: 1440, height: 900, device: "desktop" },
          { file: "plain.html", width: 400, height: 300, device: "none" },
        ],
      }),
    },
  }).then((res) => res.json())) as { id: string };

  const tab = await browser.newPage({ viewport: { width: 1440, height: 900 } });
  await tab.goto(`${server.url}/#/pages/${page.id}`);
  await tab.locator('iframe[title$="phone.html"]').waitFor();
  await tab.getByRole("button", { name: "Lancer phone.html en plein écran" }).click();
  const play = tab.getByTestId("play");
  const habillage = play.getByRole("button", { name: "Habillage" });
  const frame = play.locator("iframe");

  expect(await habillage.getAttribute("aria-pressed")).toBe("true");
  await habillage.click();
  expect(await habillage.getAttribute("aria-pressed")).toBe("false");
  await expect.poll(() => play.locator("main").getAttribute("data-device")).toBe("none");
  const stage = (await play.locator("main").boundingBox())!;
  const phone = (await frame.boundingBox())!;
  expect([phone.width, phone.height]).toEqual([390, stage.height]);
  expect(phone.x + phone.width / 2).toBeCloseTo(stage.x + stage.width / 2, 0);

  await play.getByRole("button", { name: "Artboard 2" }).click();
  await expect.poll(() => frame.getAttribute("title")).toMatch(/desk\.html$/);
  const desk = (await frame.boundingBox())!;
  expect([desk.width, desk.height]).toEqual([stage.width, stage.height]);

  await play.getByRole("button", { name: "Artboard 3" }).click();
  await expect.poll(() => frame.getAttribute("title")).toMatch(/plain\.html$/);
  expect(await habillage.count()).toBe(0);

  await tab.reload();
  await tab.locator('iframe[title$="phone.html"]').waitFor();
  await tab.getByRole("button", { name: "Lancer phone.html en plein écran" }).click();
  expect(await habillage.getAttribute("aria-pressed")).toBe("false");
  await habillage.click();
  await expect.poll(() => play.locator("main").getAttribute("data-device")).toBe("phone");

  await tab.setViewportSize({ width: 390, height: 844 });
  await expect.poll(() => play.locator("main").getAttribute("data-device")).toBe("none");
  expect(await habillage.count()).toBe(0);
  const bar = (await play.locator("header").boundingBox())!;
  expect(bar.height).toBe(44);
  await play.getByText("Onboarding · phone.html").waitFor();
  await expect.poll(async () => (await frame.boundingBox())?.width).toBe(390);
  expect((await frame.boundingBox())!.height).toBe(800);
  await play.getByRole("button", { name: "Retour au canvas" }).click();
  await expect.poll(() => play.count()).toBe(0);
  await tab.close();
}, 60_000);
