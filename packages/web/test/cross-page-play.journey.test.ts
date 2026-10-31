import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { build } from "vite";
import { type Browser, type Page } from "playwright";
import { launchBrowser } from "./journeyBrowser.js";
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
  browser = await launchBrowser();
}, 60_000);

afterAll(async () => {
  await browser?.close();
  await server?.stop();
  rmSync(webDir, { recursive: true, force: true });
});

const plain = `<!doctype html><body style="margin:0"><h1>Hi</h1></body>`;
const withButton = `<!doctype html><body style="margin:0"><button id="go">Go</button></body>`;

const targetManifest = (files: string[]) => ({
  artboards: files.map((file, i) => ({ file, title: file.replace(".html", "").toUpperCase(), width: 400, height: 300, x: 0, y: i * 1000 })),
  tweaks: [{ id: "dark", type: "toggle", label: "Dark mode" }],
});

/** Two pages of one project: "Flow" (start.html, whose #go leads to the target page) and "Checkout" (panier, paiement). */
async function setup(link: { to: string }, targetFiles = ["panier.html", "paiement.html", "ancien.html"]) {
  const project = (await (await server.post("/api/projects", { title: "Acme" })).json()) as { id: string };
  const create = async (title: string, files: Record<string, string>) =>
    (await (await server.post(`/api/projects/${project.id}/pages`, { title, files })).json()) as { id: string };
  const target = await create("Checkout", {
    ...Object.fromEntries(["panier.html", "paiement.html", "ancien.html"].map((f) => [f, plain])),
    "manifest.json": JSON.stringify(targetManifest(["panier.html", "paiement.html", "ancien.html"])),
  });
  const source = await create("Flow", {
    "start.html": withButton,
    "manifest.json": JSON.stringify({
      artboards: [{ file: "start.html", title: "Start", width: 400, height: 300, x: 0, y: 0 }],
      links: [{ from: "start.html", selector: "#go", page: target.id, ...link }],
    }),
  });
  if (targetFiles.length < 3) {
    await server.post(`/api/pages/${target.id}/versions`, {
      files: { ...Object.fromEntries(targetFiles.map((f) => [f, plain])), "manifest.json": JSON.stringify(targetManifest(targetFiles)) },
      message: "m",
      origin: "thread",
    });
  }
  const tab = await browser.newPage({ viewport: { width: 1440, height: 900 } });
  await tab.goto(`${server.url}/#/pages/${source.id}/play/start.html`);
  const play = tab.getByTestId("play");
  await play.waitFor();
  return { tab, play, source: source.id, target: target.id };
}

const hashOf = (tab: Page) => tab.evaluate(() => window.location.hash);

it("follows a cross-page link: URL, counter, arrows, tweaks and title are those of the target page", async () => {
  const { tab, play, target } = await setup({ to: "panier.html" });
  await tab.frameLocator("iframe").locator("#go").click();

  await expect.poll(() => hashOf(tab)).toBe(`#/pages/${target}/play/panier.html`);
  await play.getByText("Checkout · PANIER").waitFor();
  const counter = play.getByRole("button", { name: /\d+ \/ 3/ });
  expect((await counter.textContent())?.trim()).toMatch(/^1 \/ 3/);
  await tab.getByRole("complementary", { name: "Tweaks" }).getByText("Dark mode").waitFor();

  await play.getByRole("button", { name: "Artboard suivant (→)" }).click();
  await expect.poll(() => hashOf(tab)).toBe(`#/pages/${target}/play/paiement.html`);
  expect((await counter.textContent())?.trim()).toMatch(/^2 \/ 3/);
  await tab.close();
}, 60_000);

it("Échap lands on the target page's canvas and Back returns to the clicked screen of the first page", async () => {
  const { tab, play, source, target } = await setup({ to: "panier.html" });
  await tab.frameLocator("iframe").locator("#go").click();
  await play.getByText("Checkout · PANIER").waitFor();

  await tab.keyboard.press("Escape");
  await expect.poll(() => hashOf(tab)).toBe(`#/pages/${target}`);
  await tab.goBack();
  await expect.poll(() => hashOf(tab)).toBe(`#/pages/${target}/play/panier.html`);
  await tab.goBack();
  await expect.poll(() => hashOf(tab)).toBe(`#/pages/${source}/play/start.html`);
  await tab.getByTestId("play").getByText("Flow · Start").waitFor();
  await tab.close();
}, 60_000);

it("shows 'Cet artboard n'existe plus' and stays on the screen when the target artboard is gone", async () => {
  const { tab, play, source } = await setup({ to: "ancien.html" }, ["panier.html", "paiement.html"]);
  await tab.frameLocator("iframe").locator("#go").click();

  const message = play.getByRole("status").filter({ hasText: "Cet artboard n'existe plus" });
  await message.waitFor();
  expect(await message.innerText()).toContain("ancien.html");
  expect(await hashOf(tab)).toBe(`#/pages/${source}/play/start.html`);
  await play.getByText("Flow · Start").waitFor();
  await tab.close();
}, 60_000);
