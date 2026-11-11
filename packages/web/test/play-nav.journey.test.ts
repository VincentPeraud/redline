import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { copyBuiltWeb } from "./builtWeb.js";
import { type Browser, type Page } from "playwright";
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

const plain = `<!doctype html><body style="margin:0"><h1>Hi</h1></body>`;
const withField = `<!doctype html><body style="margin:0"><button id="go">Go</button><input id="field" type="text"><p id="para" tabindex="0">Text</p></body>`;

/** Reading order is c, a, b (rows by vertical position), the opposite of the manifest order. */
const manifest = {
  artboards: [
    { file: "a.html", title: "Alpha", width: 400, height: 300, x: 0, y: 1000 },
    { file: "b.html", title: "Beta", width: 400, height: 300, x: 600, y: 1000 },
    { file: "c.html", title: "Gamma", width: 400, height: 300, x: 0, y: 0 },
  ],
  links: [{ from: "c.html", selector: "#go", to: "b.html" }],
};

const phoneManifest = { ...manifest, artboards: manifest.artboards.map((a) => ({ ...a, width: 390, height: 844, frame: "phone" })) };

async function createPage(withManifest: object = manifest): Promise<string> {
  const project = (await (await server.post("/api/projects", { title: "Acme" })).json()) as { id: string };
  const page = (await server
    .post(`/api/projects/${project.id}/pages`, {
      title: "Flow",
      files: { "a.html": plain, "b.html": plain, "c.html": withField, "manifest.json": JSON.stringify(withManifest) },
    })
    .then((res) => res.json())) as { id: string };
  return page.id;
}

const hashOf = (tab: Page) => tab.evaluate(() => window.location.hash);
const historyLength = (tab: Page) => tab.evaluate(() => window.history.length);

async function openPlay(file: string) {
  const pageId = await createPage();
  const tab = await browser.newPage({ viewport: { width: 1440, height: 900 } });
  await tab.goto(`${server.url}/#/pages/${pageId}/play/${file}`);
  const play = tab.getByTestId("play");
  await play.waitFor();
  return { tab, play, pageId };
}

it("walks the artboards in reading order with the buttons, replaces the history entry, ends are disabled and nothing wraps", async () => {
  const { tab, play, pageId } = await openPlay("c.html");
  const counter = play.getByRole("button", { name: /\d+ \/ 3/ });
  const previous = play.getByRole("button", { name: "Artboard précédent (←)" });
  const next = play.getByRole("button", { name: "Artboard suivant (→)" });

  expect((await counter.textContent())?.trim()).toMatch(/^1 \/ 3/);
  expect(await previous.isDisabled()).toBe(true);
  expect(await next.isEnabled()).toBe(true);
  await play.getByText("Flow · Gamma").waitFor();

  const before = await historyLength(tab);
  await next.click();
  await expect.poll(() => hashOf(tab)).toBe(`#/pages/${pageId}/play/a.html`);
  await play.getByText("Flow · Alpha").waitFor();
  await next.click();
  await expect.poll(() => hashOf(tab)).toBe(`#/pages/${pageId}/play/b.html`);
  expect(await historyLength(tab)).toBe(before);
  expect((await counter.textContent())?.trim()).toMatch(/^3 \/ 3/);
  expect(await next.isDisabled()).toBe(true);

  await previous.click();
  await expect.poll(() => hashOf(tab)).toBe(`#/pages/${pageId}/play/a.html`);
  await tab.close();
}, 60_000);

it("moves with the arrow keys from the page and from inside the artboard, but not from a text field or with a modifier", async () => {
  const { tab, pageId } = await openPlay("c.html");
  const shown = () => hashOf(tab);

  await tab.keyboard.press("ArrowRight");
  await expect.poll(shown).toBe(`#/pages/${pageId}/play/a.html`);
  await tab.keyboard.press("ArrowLeft");
  await expect.poll(shown).toBe(`#/pages/${pageId}/play/c.html`);
  await tab.keyboard.press("ArrowLeft");
  expect(await shown()).toBe(`#/pages/${pageId}/play/c.html`);
  await tab.keyboard.press("Meta+ArrowRight");
  await tab.keyboard.press("Alt+ArrowRight");
  await tab.waitForTimeout(150);
  expect(await shown()).toBe(`#/pages/${pageId}/play/c.html`);

  const inside = tab.frameLocator("iframe");
  await inside.locator("#para").focus();
  await tab.keyboard.press("ArrowRight");
  await expect.poll(shown).toBe(`#/pages/${pageId}/play/a.html`);

  await tab.keyboard.press("ArrowLeft");
  await expect.poll(shown).toBe(`#/pages/${pageId}/play/c.html`);
  await inside.locator("#field").focus();
  await tab.keyboard.press("ArrowRight");
  await tab.waitForTimeout(150);
  expect(await shown()).toBe(`#/pages/${pageId}/play/c.html`);
  await tab.close();
}, 60_000);

it("opens the dark contents from the counter with the current line highlighted, goes to the chosen line and Échap closes only the menu", async () => {
  const { tab, play, pageId } = await openPlay("a.html");
  const counter = play.getByRole("button", { name: /2 \/ 3/ });
  expect(await counter.getAttribute("aria-expanded")).toBe("false");
  await counter.click();
  const menu = play.getByRole("menu", { name: "Sommaire de la page" });
  await menu.waitFor();
  expect(await counter.getAttribute("aria-expanded")).toBe("true");
  const lines = await menu.getByRole("menuitem").allTextContents();
  expect(lines.map((line) => /Gamma|Alpha|Beta/.exec(line)?.[0])).toEqual(["Gamma", "Alpha", "Beta"]);
  expect(await menu.getByRole("menuitem", { name: /Alpha/ }).getAttribute("aria-current")).toBe("true");

  await tab.keyboard.press("Escape");
  await menu.waitFor({ state: "detached" });
  await play.waitFor();
  expect(await hashOf(tab)).toBe(`#/pages/${pageId}/play/a.html`);

  const before = await historyLength(tab);
  await counter.click();
  await menu.getByRole("menuitem", { name: /Beta/ }).click();
  await expect.poll(() => hashOf(tab)).toBe(`#/pages/${pageId}/play/b.html`);
  expect(await menu.count()).toBe(0);
  expect(await historyLength(tab)).toBe(before);
  await play.getByText("Flow · Beta").waitFor();
  await tab.close();
}, 60_000);

it("does not switch artboard with the arrow keys while the contents menu is open", async () => {
  const { tab, play, pageId } = await openPlay("a.html");
  await play.getByRole("button", { name: /2 \/ 3/ }).click();
  await play.getByRole("menu", { name: "Sommaire de la page" }).waitFor();
  await tab.evaluate(() => (document.activeElement as HTMLElement | null)?.blur());
  await tab.keyboard.press("ArrowRight");
  await tab.waitForTimeout(300);
  expect(await hashOf(tab)).toBe(`#/pages/${pageId}/play/a.html`);
  await tab.close();
}, 60_000);

it("keeps rendu as written when changing artboard, and a followed link pushes one entry so Back returns to the clicked screen then to the canvas", async () => {
  const pageId = await createPage();
  const tab = await browser.newPage({ viewport: { width: 1440, height: 900 } });
  await tab.goto(`${server.url}/#/pages/${pageId}`);
  await tab.getByRole("button", { name: "Lancer c.html en plein écran" }).click();
  const play = tab.getByTestId("play");
  await play.waitFor();

  await tab.frameLocator("iframe").locator("#go").click();
  await expect.poll(() => hashOf(tab)).toBe(`#/pages/${pageId}/play/b.html`);
  await tab.goBack();
  await expect.poll(() => hashOf(tab)).toBe(`#/pages/${pageId}/play/c.html`);
  await tab.goBack();
  await tab.getByTestId("canvas").waitFor();
  expect(await hashOf(tab)).toBe(`#/pages/${pageId}`);

  await tab.goto(`${server.url}/#/pages/${pageId}/play/c.html?rendu=aucun`);
  await tab.reload();
  await play.getByRole("button", { name: "Artboard suivant (→)" }).click();
  await expect.poll(() => hashOf(tab)).toBe(`#/pages/${pageId}/play/a.html?rendu=aucun`);
  await tab.close();
}, 60_000);

it("shows ‹ n / N › as 44 px targets in the phone bar, ends disabled, and the counter opens the contents full width", async () => {
  const pageId = await createPage(phoneManifest);
  const tab = await browser.newPage({ viewport: { width: 390, height: 844 } });
  await tab.goto(`${server.url}/#/pages/${pageId}/play/c.html`);
  const play = tab.getByTestId("play");
  await play.waitFor();
  const bar = play.locator("header");
  expect((await bar.boundingBox())?.height).toBe(44);
  await bar.getByText("Flow · Gamma").waitFor();

  const previous = bar.getByRole("button", { name: "Artboard précédent" });
  const counter = bar.getByRole("button", { name: "Sommaire, artboard 1 sur 3" });
  const next = bar.getByRole("button", { name: "Artboard suivant" });
  expect((await counter.textContent())?.trim()).toBe("1 / 3");
  expect(await previous.isDisabled()).toBe(true);
  for (const button of [previous, counter, next]) expect((await button.boundingBox())?.height).toBe(44);

  const before = await historyLength(tab);
  await next.click();
  await expect.poll(() => hashOf(tab)).toBe(`#/pages/${pageId}/play/a.html`);
  expect(await historyLength(tab)).toBe(before);
  await next.click();
  await expect.poll(() => hashOf(tab)).toBe(`#/pages/${pageId}/play/b.html`);
  expect(await next.isDisabled()).toBe(true);

  await bar.getByRole("button", { name: "Sommaire, artboard 3 sur 3" }).click();
  const menu = play.getByRole("menu", { name: "Sommaire de la page" });
  await menu.waitFor();
  const box = (await menu.boundingBox())!;
  expect([box.x, box.width]).toEqual([0, 390]);
  expect(box.y).toBe(44);
  await menu.getByRole("menuitem", { name: /Gamma/ }).click();
  await expect.poll(() => hashOf(tab)).toBe(`#/pages/${pageId}/play/c.html`);
  expect(await menu.count()).toBe(0);
  await tab.close();
}, 60_000);

it("starts the presentation from the page's top bar on the first artboard in reading order", async () => {
  const pageId = await createPage();
  const tab = await browser.newPage({ viewport: { width: 1440, height: 900 } });
  await tab.goto(`${server.url}/#/pages/${pageId}`);
  await tab.getByRole("button", { name: "Présenter" }).click();
  await tab.getByTestId("play").getByText("Flow · Gamma").waitFor();
  expect(await hashOf(tab)).toBe(`#/pages/${pageId}/play/c.html`);
  await tab.close();
});
