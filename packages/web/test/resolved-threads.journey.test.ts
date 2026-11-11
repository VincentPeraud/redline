import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { copyBuiltWeb } from "./builtWeb.js";
import { type Browser } from "playwright";
import { launchBrowser } from "./journeyBrowser.js";
import { afterAll, beforeAll, expect, it } from "vitest";
import type { Thread } from "@redline/shared";
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

it("unfolds a resolved thread to read its discussion, and reopens it among the open threads", async () => {
  const page = await seam.createPage({ "home.html": "<!doctype html><h1>Title</h1>" });
  const post = (path: string, body: object) =>
    fetch(`${seam.server.url}${path}`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
  const thread = (await (await post(`/api/pages/${page.id}/threads`, { artboard: "home.html", selector: "body > h1", xPct: 10, yPct: 10, body: "Start the week on Monday" })).json()) as Thread;
  await engine.finished(1);
  await post(`/api/threads/${thread.id}/resolve`, {});

  const tab = await browser.newPage({ viewport: { width: 1400, height: 900 } });
  await tab.goto(`${seam.server.url}/#/pages/${page.id}`);
  await tab.getByRole("tab", { name: /Commentaires/ }).click();
  const row = tab.getByRole("button", { name: /Start the week on Monday.*Résolu/ });
  await row.waitFor();
  expect(await row.getAttribute("aria-expanded")).toBe("false");
  expect(await tab.getByRole("button", { name: "Rouvrir" }).count()).toBe(0);

  await row.click();
  expect(await row.getAttribute("aria-expanded")).toBe("true");
  await tab.getByRole("button", { name: "Rouvrir" }).click();
  await tab.getByRole("button", { name: "Résoudre" }).waitFor();
  expect(await tab.getByRole("button", { name: /Résolu/ }).count()).toBe(0);
  await tab.close();
}, 60_000);
