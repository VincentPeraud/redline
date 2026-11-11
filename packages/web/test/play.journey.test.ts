import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { copyBuiltWeb } from "./builtWeb.js";
import { type Browser } from "playwright";
import { launchBrowser } from "./journeyBrowser.js";
import { afterAll, beforeAll, expect, it } from "vitest";
import { startTestServer, type TestServer } from "@redline/server/test-harness";

let server: TestServer;
let browser: Browser;
let webDir: string;

beforeAll(async () => {
  webDir = mkdtempSync(join(tmpdir(), "redline-web-"));
  copyBuiltWeb(webDir);
  server = await startTestServer({ webDir });
  browser = await launchBrowser();
}, 60_000);

afterAll(async () => {
  await browser?.close();
  await server?.stop();
  rmSync(webDir, { recursive: true, force: true });
});

/** Goes to an artboard through the counter's contents menu. */
async function openArtboard(play: Locator, file: string) {
  await play.getByRole("button", { name: /^\d+ \/ \d+/ }).click();
  await play.getByRole("menuitem", { name: new RegExp(file.replace(".", "\\.")) }).click();
}

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

it("presents each artboard by its declared frame, and as is when none is declared", async () => {
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
          { file: "a.html", width: 390, height: 844, frame: "phone" },
          { file: "b.html", width: 576, height: 746, frame: "tablet" },
          { file: "c.html", width: 1440, height: 900, frame: "browser", url: "lumora.fr" },
          { file: "d.html", width: 576, height: 814, frame: "paper" },
          { file: "e.html", width: 400, height: 300 },
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

  const expected = ["phone", "tablet", "browser", "paper", "none", "none"];
  for (const [index, name] of expected.entries()) {
    await openArtboard(play, `${"abcdef"[index]}.html`);
    await expect.poll(() => play.locator("main").getAttribute("data-frame")).toBe(name);
    expect(await play.locator("main [data-frame]").getAttribute("data-frame")).toBe(name);
  }

  await openArtboard(play, "c.html");
  await expect.poll(() => play.locator("main").getAttribute("data-frame")).toBe("browser");
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
          { file: "dash.html", width: 1000, height: 600, frame: "browser", expand: "fill", guides: { columns: 12, gutter: 24, margin: 80 } },
          { file: "phone.html", width: 390, height: 844, frame: "phone", expand: "fill" },
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
  await expect.poll(() => columns.count()).toBe(12);
  await tab.locator("body").press("g");
  expect(await columns.count()).toBe(0);

  await openArtboard(play, "phone.html");
  await expect.poll(() => play.locator("main").getAttribute("data-frame")).toBe("phone");
  const phone = (await frame.boundingBox())!;
  expect(phone.width / phone.height).toBeCloseTo(390 / 760, 2);
  expect(phone.width).toBeLessThan((await stage.boundingBox())!.width);
  await tab.close();
}, 60_000);

it("removes the frame with Habillage (remembered), and fills the screen without a frame on a narrow window", async () => {
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
          { file: "phone.html", width: 390, height: 844, frame: "phone" },
          { file: "desk.html", width: 1440, height: 900, frame: "browser" },
          { file: "plain.html", width: 400, height: 300 },
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
  await expect.poll(() => play.locator("main").getAttribute("data-frame")).toBe("none");
  const stage = (await play.locator("main").boundingBox())!;
  const phone = (await frame.boundingBox())!;
  expect([phone.width, phone.height]).toEqual([390, stage.height]);
  expect(phone.x + phone.width / 2).toBeCloseTo(stage.x + stage.width / 2, 0);

  await openArtboard(play, "desk.html");
  await expect.poll(() => frame.getAttribute("title")).toMatch(/desk\.html$/);
  const desk = (await frame.boundingBox())!;
  expect([desk.width, desk.height]).toEqual([stage.width, stage.height]);

  await openArtboard(play, "plain.html");
  await expect.poll(() => frame.getAttribute("title")).toMatch(/plain\.html$/);
  expect(await habillage.count()).toBe(0);

  await tab.reload();
  await openArtboard(play, "phone.html");
  await tab.locator('iframe[title$="phone.html"]').waitFor();
  expect(await habillage.getAttribute("aria-pressed")).toBe("false");
  await habillage.click();
  await expect.poll(() => play.locator("main").getAttribute("data-frame")).toBe("phone");

  await tab.setViewportSize({ width: 390, height: 844 });
  await expect.poll(() => play.locator("main").getAttribute("data-frame")).toBe("none");
  expect(await habillage.count()).toBe(0);
  const bar = (await play.locator("header").boundingBox())!;
  expect(bar.height).toBe(44);
  await play.getByText("Habillage · phone.html").waitFor();
  await expect.poll(async () => (await frame.boundingBox())?.width).toBe(390);
  expect((await frame.boundingBox())!.height).toBe(800);
  await play.getByRole("button", { name: "Retour au canvas" }).click();
  await expect.poll(() => play.count()).toBe(0);
  await tab.close();
}, 60_000);

it("plays a responsive artboard: a selector of its formats plus Aucun, each format in its frame at its own size, remembered", async () => {
  const project = (await (await server.post("/api/projects", { title: "Responsive play" })).json()) as { id: string };
  const tall = `<!doctype html><body style="margin:0"><div style="height:2400px;background:#eee">Tall</div></body>`;
  const page = (await server.post(`/api/projects/${project.id}/pages`, {
    title: "Responsive play",
    files: {
      "landing.html": tall,
      "plain.html": tall,
      "manifest.json": JSON.stringify({
        artboards: [
          { file: "landing.html", x: 0, y: 0, responsive: ["desktop", "tablet", { format: "mobile", width: 414, height: 896 }] },
          { file: "plain.html", x: 5000, y: 0, width: 400, height: 300 },
        ],
      }),
    },
  }).then((res) => res.json())) as { id: string };

  const tab = await browser.newPage({ viewport: { width: 1440, height: 900 } });
  await tab.goto(`${server.url}/#/pages/${page.id}`);
  await tab.locator("[data-rendering] iframe").first().waitFor();
  await tab.getByRole("button", { name: "Lancer landing.html en plein écran" }).click();
  const play = tab.getByTestId("play");
  const selector = play.getByRole("group", { name: "Rendu responsive" });
  const frame = play.locator("iframe");
  const size = () => frame.evaluate((el) => [(el as HTMLElement).offsetWidth, (el as HTMLElement).offsetHeight]);

  await selector.waitFor();
  expect(await selector.getByRole("button").allTextContents()).toEqual(["Desktop", "Tablette", "Mobile", "Aucun"]);
  expect(await selector.getByRole("button", { name: "Desktop" }).getAttribute("aria-pressed")).toBe("true");
  expect(await play.locator("main").getAttribute("data-frame")).toBe("browser");
  expect(await size()).toEqual([1440, 900]);

  await selector.getByRole("button", { name: "Tablette" }).click();
  await expect.poll(() => play.locator("main").getAttribute("data-frame")).toBe("tablet");
  expect(await size()).toEqual([768, 1024]);

  await selector.getByRole("button", { name: "Mobile" }).click();
  await expect.poll(() => play.locator("main").getAttribute("data-frame")).toBe("phone");
  expect(await size()).toEqual([414, 896]);

  await selector.getByRole("button", { name: "Aucun" }).click();
  await expect.poll(() => play.locator("main").getAttribute("data-frame")).toBe("none");
  const stage = (await play.locator("main").boundingBox())!;
  expect(await size()).toEqual([stage.width, stage.height]);
  expect(await play.getByRole("button", { name: "Habillage" }).count()).toBe(0);

  await selector.getByRole("button", { name: "Tablette" }).click();
  await tab.reload();
  await selector.waitFor();
  expect(await selector.getByRole("button", { name: "Tablette" }).getAttribute("aria-pressed")).toBe("true");
  expect(await play.locator("main").getAttribute("data-frame")).toBe("tablet");

  await openArtboard(play, "plain.html");
  await expect.poll(() => frame.getAttribute("title")).toMatch(/plain\.html$/);
  expect(await selector.count()).toBe(0);
  await tab.close();
}, 60_000);
