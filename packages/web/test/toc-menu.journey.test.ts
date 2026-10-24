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

it("lists the artboards in reading order under their groups, filters, and centres the canvas on a click", async () => {
  const project = (await (await server.post("/api/projects", { title: "Toc" })).json()) as { id: string };
  const html = (title: string) => `<!doctype html><body style="margin:0"><h1>${title}</h1></body>`;
  const page = (await (
    await server.post(`/api/projects/${project.id}/pages`, {
      title: "Flow",
      files: {
        "payment.html": html("Payment"),
        "specialite.html": html("Spécialité"),
        "welcome.html": html("Welcome"),
        "loose.html": html("Loose"),
        "manifest.json": JSON.stringify({
          artboards: [
            { file: "payment.html", title: "Paiement", width: 300, height: 200, x: 0, y: 600 },
            { file: "specialite.html", title: "Spécialité", width: 300, height: 200, x: 400, y: 0 },
            { file: "welcome.html", title: "Bienvenue", width: 300, height: 200, x: 0, y: 0 },
            { file: "loose.html", width: 300, height: 200, x: 3000, y: 0 },
          ],
          elements: [
            { text: "Onboarding", x: 0, y: -80, width: 800 },
            { text: "Checkout", x: 0, y: 520, width: 800 },
          ],
        }),
      },
    })
  ).json()) as Page;
  await server.post(`/api/pages/${page.id}/threads`, { artboard: "specialite.html", selector: "h1", xPct: 20, yPct: 30, body: "Too small" });

  const tab = await browser.newPage({ viewport: { width: 1440, height: 900 } });
  await tab.goto(`${server.url}/#/pages/${page.id}`);
  await tab.frameLocator('iframe[title$="welcome.html"]').getByText("Welcome").waitFor();
  const urlBefore = tab.url();

  const toggle = tab.getByRole("button", { name: /4 artboards/ });
  await toggle.click();
  const menu = tab.getByRole("menu", { name: "Sommaire de la page" });
  const lines = menu.getByRole("menuitem");
  await expect.poll(async () => lines.allTextContents()).toEqual([
    "1Bienvenuewelcome.html",
    "2Spécialitéspecialite.html1 fil",
    "3loose.htmlloose.html",
    "4Paiementpayment.html",
  ]);
  expect(await menu.getByRole("group").evaluateAll((groups) => groups.map((g) => g.getAttribute("aria-label")))).toEqual(["Onboarding", null, "Checkout"]);

  await menu.getByRole("searchbox", { name: "Filtrer les artboards" }).fill("SPECIALITE");
  await expect.poll(async () => lines.allTextContents()).toEqual(["2Spécialitéspecialite.html1 fil"]);
  expect(await menu.getByText("Checkout").count()).toBe(0);

  await tab.keyboard.press("Escape");
  await menu.waitFor({ state: "detached" });
  await toggle.click();
  await tab.mouse.click(700, 600);
  await menu.waitFor({ state: "detached" });

  await toggle.click();
  await menu.getByRole("menuitem", { name: /Paiement/ }).click();
  await menu.waitFor({ state: "detached" });
  const canvas = await box(tab.getByTestId("canvas"));
  const payment = await box(tab.locator('iframe[title$="payment.html"]'));
  // Zoomed to frame the artboard (here 100 %, the cap), not left at the page's fit zoom.
  expect(payment.width).toBeCloseTo(300, 0);
  expect(payment.x + payment.width / 2).toBeCloseTo(canvas.x + canvas.width / 2, 0);
  expect(payment.y + payment.height / 2).toBeCloseTo(canvas.y + canvas.height / 2, 0);
  expect(tab.url()).toBe(urlBefore);
}, 60_000);
