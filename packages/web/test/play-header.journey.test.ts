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

const html = `<!doctype html><body style="margin:0"><h1>Hi</h1></body>`;

async function createPage(title: string, manifest: object): Promise<string> {
  const project = (await (await server.post("/api/projects", { title })).json()) as { id: string };
  const page = (await server.post(`/api/projects/${project.id}/pages`, {
    title,
    files: { "a.html": html, "b.html": html, "manifest.json": JSON.stringify(manifest) },
  }).then((res) => res.json())) as { id: string };
  return page.id;
}

it("names the header nav entries after the artboard titles, offers Guides only on an artboard that declares them and Habillage never on paper", async () => {
  const pageId = await createPage("Header", {
    artboards: [
      { file: "a.html", title: "Tableau de bord", width: 1000, height: 600, frame: "browser", guides: { columns: 12, gutter: 24, margin: 80 } },
      { file: "b.html", width: 576, height: 814, frame: "paper" },
    ],
  });
  const tab = await browser.newPage({ viewport: { width: 1440, height: 900 } });
  await tab.goto(`${server.url}/#/pages/${pageId}`);
  await tab.getByRole("button", { name: "Lancer a.html en plein écran" }).click();
  const play = tab.getByTestId("play");
  const nav = play.getByRole("navigation", { name: "Artboards" });

  expect(await nav.getByRole("button").allTextContents()).toEqual(["Tableau de bord", "Artboard 2"]);
  expect(await play.getByRole("button", { name: "Guides (G)" }).count()).toBe(1);
  expect(await play.getByRole("button", { name: "Habillage" }).count()).toBe(1);

  await nav.getByRole("button", { name: "Artboard 2" }).click();
  await expect.poll(() => play.locator("main").getAttribute("data-frame")).toBe("paper");
  expect(await play.getByRole("button", { name: "Guides (G)" }).count()).toBe(0);
  expect(await play.getByRole("button", { name: "Habillage" }).count()).toBe(0);

  // turning Habillage off elsewhere does not strip the sheet
  await nav.getByRole("button", { name: "Tableau de bord" }).click();
  await play.getByRole("button", { name: "Habillage" }).click();
  await nav.getByRole("button", { name: "Artboard 2" }).click();
  await expect.poll(() => play.locator("main").getAttribute("data-frame")).toBe("paper");
  await tab.close();
}, 60_000);

it("has a Tweaks toggle only when the page has tweaks: panel open by default, choice remembered, and typing g in a field leaves the guides alone", async () => {
  const pageId = await createPage("Tweaks toggle", {
    artboards: [{ file: "a.html", width: 1000, height: 600, frame: "browser", guides: { columns: 12, gutter: 24, margin: 80 } }],
    tweaks: [{ id: "title", type: "text", label: "Title", default: "Welcome" }],
  });
  const plainId = await createPage("No tweaks", { artboards: [{ file: "a.html", width: 1000, height: 600 }] });
  const tab = await browser.newPage({ viewport: { width: 1440, height: 900 } });
  await tab.goto(`${server.url}/#/pages/${pageId}`);
  await tab.getByRole("button", { name: "Lancer a.html en plein écran" }).click();
  const play = tab.getByTestId("play");
  const toggle = play.getByRole("button", { name: "Tweaks", exact: true });
  const panel = play.getByRole("complementary", { name: "Tweaks" });

  expect(await play.getByText("Tweaks ouverts").count()).toBe(0);
  expect(await toggle.getAttribute("aria-pressed")).toBe("true");
  await panel.waitFor();

  await panel.getByLabel("Title").fill("gggg");
  expect(await play.locator("[data-guide-column]").count()).toBe(0);

  await toggle.click();
  expect(await panel.count()).toBe(0);
  await tab.reload();
  expect(await toggle.getAttribute("aria-pressed")).toBe("false");
  expect(await panel.count()).toBe(0);
  await toggle.click();
  await panel.waitFor();

  await tab.goto(`${server.url}/#/pages/${plainId}`);
  await tab.getByRole("button", { name: "Lancer a.html en plein écran" }).click();
  expect(await play.getByRole("button", { name: "Tweaks", exact: true }).count()).toBe(0);
  await tab.close();
}, 60_000);

it("plays a responsive artboard's mobile rendering in a narrow window with the 44 px bar, the page title and a usable rendering selector", async () => {
  const pageId = await createPage("Narrow", {
    title: "Manifest title",
    artboards: [{ file: "a.html", responsive: ["desktop", "mobile"] }],
  });
  const tab = await browser.newPage({ viewport: { width: 1440, height: 900 } });
  await tab.goto(`${server.url}/#/pages/${pageId}`);
  await tab.locator("[data-rendering] iframe").first().waitFor();
  await tab.getByRole("button", { name: "Lancer a.html en plein écran" }).click();
  const play = tab.getByTestId("play");
  await play.getByRole("group", { name: "Rendu responsive" }).getByRole("button", { name: "Mobile" }).click();

  await tab.setViewportSize({ width: 390, height: 844 });
  await expect.poll(async () => (await play.locator("header").boundingBox())?.height).toBe(44);
  await play.getByText("Narrow · a.html").waitFor();
  const selector = play.getByRole("combobox", { name: "Rendu responsive" });
  expect(await selector.inputValue()).toBe("mobile-390");

  await selector.selectOption("desktop-1440");
  await expect.poll(() => play.locator("main").getAttribute("data-frame")).toBe("browser");
  await tab.close();
}, 60_000);
