import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { copyBuiltWeb } from "./builtWeb.js";
import { type Browser } from "playwright";
import { launchBrowser } from "./journeyBrowser.js";
import { afterAll, beforeAll, expect, it } from "vitest";
import { FakeEngine, startSeam2, type Seam2 } from "@redline/agent/seam2";

let browser: Browser;
let webDir: string;
let seam: Seam2;
const engine = new FakeEngine([{ type: "result", summary: "Done" }]);

beforeAll(async () => {
  webDir = mkdtempSync(join(tmpdir(), "redline-web-"));
  copyBuiltWeb(webDir);
  seam = await startSeam2(engine, { webDir });
  browser = await launchBrowser();
}, 60_000);

afterAll(async () => {
  await browser?.close();
  await seam?.stop();
  rmSync(webDir, { recursive: true, force: true });
});

it("picks canvas elements in selection mode: outline, numbered chip and mark, dedup, id-less ignored, links not followed", async () => {
  const before = engine.runs.length;
  const page = await seam.createPage({
    "home.html": `<!doctype html><body style="margin:0"><button id="go">Go</button></body>`,
    "manifest.json": JSON.stringify({
      artboards: [{ file: "home.html", title: "Accueil", width: 400, height: 300, x: 0, y: 200 }],
      elements: [
        { id: "note-parcours", kind: "sticky", text: "Parcours : accueil, paiement", width: 220, color: "yellow", x: 500, y: 200 },
        { kind: "sticky", text: "Ancienne note sans id", width: 220, color: "pink", x: 500, y: 450 },
        { id: "carte-site", kind: "link", url: "https://example.com/menu", title: "Menu", x: 0, y: 600 },
      ],
    }),
  });
  const tab = await browser.newPage({ viewport: { width: 1440, height: 900 } });
  await tab.goto(`${seam.server.url}/#/pages/${page.id}`);
  const panel = tab.getByTestId("conversations");
  const chips = panel.getByTestId("composer-chip");
  const marks = tab.locator("[data-canvas-mark]");
  const note = tab.locator("[data-canvas-sticky][data-canvas-element-id=note-parcours]");
  await note.waitFor();
  await tab.waitForTimeout(300);

  await panel.getByRole("button", { name: "+ Élément" }).click();
  await note.hover();
  await tab.getByTestId("canvas-hover-outline").waitFor();
  expect(await tab.getByTestId("canvas-hover-label").textContent()).toBe("Post-it · note-parcours");

  await note.click();
  await expect.poll(() => chips.allTextContents()).toEqual(["1Post-it ·note-parcours×"]);
  expect(await marks.count()).toBe(1);
  expect(await marks.first().textContent()).toBe("1");
  await note.click();
  expect(await chips.count()).toBe(1);

  await tab.getByText("Ancienne note sans id").click();
  expect(await chips.count()).toBe(1);

  const popups: string[] = [];
  tab.context().on("page", (opened) => popups.push(opened.url()));
  await tab.locator("[data-canvas-element-id=carte-site]").click();
  await expect.poll(() => chips.count()).toBe(2);
  expect(await chips.nth(1).textContent()).toBe("2Lien ·carte-site×");
  expect(popups).toEqual([]);

  await panel.getByRole("button", { name: "Retirer note-parcours" }).click();
  await expect.poll(() => chips.count()).toBe(1);
  expect(await marks.count()).toBe(1);
  expect(await marks.first().textContent()).toBe("1");

  await tab.locator("#conversation-message").fill("Restyle 1");
  await panel.getByRole("button", { name: "Envoyer" }).click();
  await engine.finished(before + 1);
  expect(engine.runs[before].message).toContain("Elements the user points at:\n1: the canvas element `carte-site` (link,");
  await expect.poll(() => chips.count()).toBe(0);
  await expect.poll(() => marks.count()).toBe(0);
}, 90_000);
