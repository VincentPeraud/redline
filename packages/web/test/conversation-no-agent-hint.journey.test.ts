import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { copyBuiltWeb } from "./builtWeb.js";
import { type Browser, type Page as Tab } from "playwright";
import { launchBrowser } from "./journeyBrowser.js";
import { afterAll, afterEach, beforeAll, expect, it } from "vitest";
import { FakeEngine, startSeam2, type Seam2 } from "@redline/agent/seam2";

let browser: Browser;
let webDir: string;
let seam: Seam2 | undefined;
let openTab: Tab | undefined;

const FILES = { "home.html": "<!doctype html><h1>Home</h1>" };

beforeAll(async () => {
  webDir = mkdtempSync(join(tmpdir(), "redline-web-"));
  copyBuiltWeb(webDir);
  browser = await launchBrowser();
}, 60_000);

afterEach(async () => {
  await openTab?.close();
  openTab = undefined;
  await seam?.stop();
  seam = undefined;
});

afterAll(async () => {
  await browser?.close();
  rmSync(webDir, { recursive: true, force: true });
});

async function waitUntilOffline(s: Seam2): Promise<void> {
  for (let i = 0; i < 100; i++) {
    const agents = (await (await s.server.get("/api/agents")).json()) as { status: string }[];
    if (agents.every((a) => a.status === "offline")) return;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  throw new Error("agent still online");
}

it("tells the Conversation tab, while no agent runs, that a Claude Code conversation can handle the comments", async () => {
  seam = await startSeam2(new FakeEngine([{ type: "result", summary: "ok" }]), { webDir });
  const page = await seam.createPage(FILES, "Partager", "conversation");
  const tab = await browser.newPage({ viewport: { width: 1440, height: 900 } });
  openTab = tab;
  await tab.goto(`${seam.server.url}/#/pages/${page.id}`);
  await tab.getByRole("tab", { name: /^Conversation/ }).click();
  await expect.poll(() => tab.getByTestId("conversations").isVisible()).toBe(true);
  expect(await tab.getByTestId("no-agent-hint").count()).toBe(0);

  seam.agent.close();
  await waitUntilOffline(seam);

  await expect.poll(async () => (await tab.getByTestId("no-agent-hint").textContent())?.replace(/ /g, " ")).toBe(
    "Aucun agent ne tourne pour ce projet. Demande « traite les commentaires de Partager » à une conversation Claude Code.",
  );
}, 30_000);
