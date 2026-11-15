import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { copyBuiltWeb } from "./builtWeb.js";
import { type Browser } from "playwright";
import { launchBrowser } from "./journeyBrowser.js";
import { afterAll, beforeAll, expect, it } from "vitest";
import type { AgentInfo } from "@redline/shared";
import { FakeEngine, startSeam2, type Seam2 } from "@redline/agent/seam2";

let browser: Browser;
let webDir: string;
let seam: Seam2;

beforeAll(async () => {
  webDir = mkdtempSync(join(tmpdir(), "redline-web-"));
  copyBuiltWeb(webDir);
  seam = await startSeam2(new FakeEngine([{ type: "result", summary: "Nothing to change" }]), { webDir });
  browser = await launchBrowser();
}, 60_000);

afterAll(async () => {
  await browser?.close();
  await seam?.stop();
  rmSync(webDir, { recursive: true, force: true });
});

it("shows 'En file' with the reason on a thread whose agent is offline", async () => {
  const page = await seam.createPage({ "home.html": "<!doctype html><h1>Title</h1>" });
  seam.agent.close();
  await expect
    .poll(async () => ((await (await seam.server.get("/api/agents")).json()) as AgentInfo[]).map((a) => a.status))
    .toEqual(["offline"]);
  await seam.pinThread(page.id, "home.html", "Is anyone there?");

  const tab = await browser.newPage({ viewport: { width: 1400, height: 900 } });
  await tab.goto(`${seam.server.url}/#/pages/${page.id}`);
  await tab.getByRole("tab", { name: /^Commentaires/ }).click();
  await expect.poll(() => tab.getByTestId("queued").textContent()).toBe("En file · agent hors ligne");
}, 60_000);
