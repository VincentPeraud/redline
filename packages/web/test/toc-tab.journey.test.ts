import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { copyBuiltWeb } from "./builtWeb.js";
import { type Browser, type Locator } from "playwright";
import { launchBrowser } from "./journeyBrowser.js";
import { afterAll, beforeAll, expect, it } from "vitest";
import type { Page } from "@redline/shared";
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

async function box(locator: Locator) {
  const result = await locator.boundingBox();
  if (!result) throw new Error("element has no box");
  return result;
}

it("shows the table of contents in a side tab that highlights the centred artboard and follows panning", async () => {
  const project = (await (await server.post("/api/projects", { title: "Toc tab" })).json()) as { id: string };
  const html = (title: string) => `<!doctype html><body style="margin:0"><h1>${title}</h1></body>`;
  const page = (await (
    await server.post(`/api/projects/${project.id}/pages`, {
      title: "Flow",
      files: {
        "welcome.html": html("Welcome"),
        "specialite.html": html("Spécialité"),
        "payment.html": html("Payment"),
        "manifest.json": JSON.stringify({
          artboards: [
            { file: "welcome.html", title: "Bienvenue", width: 300, height: 200, x: 0, y: 0 },
            { file: "specialite.html", title: "Spécialité", width: 300, height: 200, x: 2000, y: 0 },
            { file: "payment.html", title: "Paiement", width: 300, height: 200, x: 0, y: 2000 },
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

  const tabs = tab.getByRole("tablist", { name: "Panneau latéral" }).getByRole("tab");
  expect(await tabs.allTextContents()).toEqual(["Conversation", "Commentaires · 1", "Sommaire"]);
  await tabs.nth(2).click();
  expect(await tabs.nth(2).evaluate((node) => getComputedStyle(node).borderBottomColor)).toBe("rgb(24, 24, 27)");
  const panel = tab.getByRole("complementary");
  const lines = panel.getByRole("menuitem");
  await expect.poll(async () => lines.allTextContents()).toEqual(["1Bienvenuewelcome.html", "2Spécialitéspecialite.html1 fil", "3Paiementpayment.html"]);
  const current = panel.locator('[aria-current="true"]');
  await lines.nth(0).click();
  await expect.poll(async () => current.allTextContents()).toEqual(["1Bienvenuewelcome.html"]);

  const filter = panel.getByRole("searchbox", { name: "Filtrer les artboards" });
  await filter.fill("paie");
  await expect.poll(async () => lines.allTextContents()).toEqual(["3Paiementpayment.html"]);
  await filter.fill("");

  const canvas = await box(tab.getByTestId("canvas"));
  await tab.mouse.move(canvas.x + 200, canvas.y + 200);
  await tab.mouse.wheel(0, 2000);
  await expect.poll(async () => current.allTextContents()).toEqual(["3Paiementpayment.html"]);

  await lines.nth(1).click();
  await expect.poll(async () => current.allTextContents()).toEqual(["2Spécialitéspecialite.html1 fil"]);
  const after = await box(tab.getByTestId("canvas"));
  // The canvas glides to the artboard: measure once it has landed.
  const centreOffset = async () => {
    const frame = await box(tab.locator('iframe[title$="specialite.html"]'));
    return Math.abs(frame.x + frame.width / 2 - (after.x + after.width / 2)) + Math.abs(frame.y + frame.height / 2 - (after.y + after.height / 2));
  };
  await expect.poll(centreOffset).toBeLessThan(1);
  const specialite = await box(tab.locator('iframe[title$="specialite.html"]'));
  expect(specialite.x + specialite.width / 2).toBeCloseTo(after.x + after.width / 2, 0);
  expect(specialite.y + specialite.height / 2).toBeCloseTo(after.y + after.height / 2, 0);
  expect(tab.url()).toBe(urlBefore);
}, 60_000);
