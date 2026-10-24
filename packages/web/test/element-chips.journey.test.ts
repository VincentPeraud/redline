import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { build } from "vite";
import { chromium, type Browser } from "playwright";
import { afterAll, beforeAll, expect, it } from "vitest";
import { FakeEngine, startSeam2, type Seam2 } from "@redline/agent/seam2";

const webRoot = fileURLToPath(new URL("..", import.meta.url));

let browser: Browser;
let webDir: string;
let seam: Seam2;
const engine = new FakeEngine([{ type: "result", summary: "Done" }]);

beforeAll(async () => {
  webDir = mkdtempSync(join(tmpdir(), "redline-web-"));
  await build({ root: webRoot, logLevel: "silent", build: { outDir: webDir, emptyOutDir: true } });
  seam = await startSeam2(engine, { webDir });
  browser = await chromium.launch();
}, 60_000);

afterAll(async () => {
  await browser?.close();
  await seam?.stop();
  rmSync(webDir, { recursive: true, force: true });
});

it("adds numbered chips and marks in selection mode, removes one, leaves with Escape, and clears them at send", async () => {
  const before = engine.runs.length;
  const page = await seam.createPage({
    "home.html": `<!doctype html><body style="margin:0;background:#120A1F"><button id="go" style="margin:60px 40px;width:160px;height:40px">Réserver ma place</button><div id="card" style="margin:20px 40px;width:200px;height:60px;background:#2A1C3F;color:#fff">La maison hantée</div></body>`,
    "manifest.json": JSON.stringify({ artboards: [{ file: "home.html", title: "Accueil", width: 400, height: 300, x: 0, y: 0 }] }),
  });
  const tab = await browser.newPage({ viewport: { width: 1440, height: 900 } });
  await tab.goto(`${seam.server.url}/#/pages/${page.id}`);
  const panel = tab.getByTestId("conversations");
  const frame = tab.frameLocator('iframe[title$="home.html"]');
  const chips = panel.getByTestId("composer-chip");
  const hint = "Sélection : clique sur un élément, un artboard ou une note pour l'ajouter au message";
  await frame.locator("#go").waitFor();
  await new Promise((resolve) => setTimeout(resolve, 300));

  await panel.getByRole("button", { name: "+ Élément" }).click();
  await tab.getByText(hint).waitFor();
  await panel.getByText("mode sélection actif").waitFor();

  await frame.locator("#go").click();
  await expect.poll(() => chips.allTextContents()).toEqual(["1Bouton ·Réserver ma place×"]);
  await expect.poll(() => frame.locator('#__redline-marks [data-mark="1"] [data-part=badge]').textContent()).toBe("1");
  await frame.locator("#go").click();
  await frame.locator("#card").click();
  await tab.locator('[data-strip="home.html"]').click({ position: { x: 20, y: 10 } });
  await expect.poll(() => chips.count()).toBe(3);
  expect(await chips.nth(2).textContent()).toBe("3Artboard ·home×");

  await panel.getByRole("button", { name: "Retirer La maison hantée" }).click();
  await expect.poll(() => chips.count()).toBe(2);
  expect(await chips.nth(1).textContent()).toBe("2Artboard ·home×");
  await expect.poll(() => frame.locator("#__redline-marks [data-mark]").count()).toBe(1);

  await frame.locator("#go").press("Escape");
  await expect.poll(() => tab.getByText(hint).count()).toBe(0);
  expect(await chips.count()).toBe(2);

  await tab.getByRole("tab", { name: /Commentaires/ }).click();
  await tab.getByRole("tab", { name: "Conversation" }).click();
  expect(await panel.getByTestId("composer-chip").count()).toBe(2);

  await panel.getByRole("button", { name: "+ Élément" }).click();
  await tab.getByText(hint).waitFor();
  await panel.getByRole("button", { name: "+ Élément" }).click();
  await expect.poll(() => tab.getByText(hint).count()).toBe(0);

  await panel.getByLabel("Message à Claude").fill("Give 2 the style of 1");
  await panel.getByRole("button", { name: "Envoyer" }).click();
  await engine.finished(before + 1);
  expect(engine.runs[before].message).toContain(
    "Elements the user points at:\n1: element `#go` (named « bouton « Réserver ma place » ») on artboard home.html\n2: the whole artboard home.html",
  );
  await expect.poll(() => chips.count()).toBe(0);
  await expect.poll(() => frame.locator("#__redline-marks [data-mark]").count()).toBe(0);
  await expect.poll(() => panel.getByTestId("message-chips").first().textContent()).toBe("1Bouton ·Réserver ma place2Artboard ·home");
}, 90_000);
