import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { copyBuiltWeb } from "./builtWeb.js";
import { type Browser, type Frame, type Page } from "playwright";
import { launchBrowser } from "./journeyBrowser.js";
import { afterAll, beforeAll, expect, it } from "vitest";
import { FakeEngine, startSeam2, type Seam2 } from "@redline/agent/seam2";
import type { AgentTokenResponse, Page as RedlinePage } from "@redline/shared";

let browser: Browser;
let webDir: string;
let seam: Seam2;
let headers: Record<string, string>;

beforeAll(async () => {
  webDir = mkdtempSync(join(tmpdir(), "redline-web-"));
  copyBuiltWeb(webDir);
  seam = await startSeam2(new FakeEngine(() => []), { webDir });
  browser = await launchBrowser();
  const { token } = (await (await seam.server.get("/api/agent-token")).json()) as AgentTokenResponse;
  headers = { authorization: `Bearer ${token}`, "content-type": "application/json" };
}, 60_000);

afterAll(async () => {
  await browser?.close();
  await seam?.stop();
  rmSync(webDir, { recursive: true, force: true });
});

const SESSION = "7d6f3f6e-0000-4000-8000-000000000020";
const call = (path: string, body: unknown) => fetch(`${seam.server.url}/agent-api${path}`, { method: "POST", headers, body: JSON.stringify(body) });
const HOME = { file: "home.html", title: "Home", x: 0, y: 0, width: 1200, height: 800, frame: "browser" };
const FRESH = { file: "fresh.html", title: "Fresh", x: 1300, y: 0, width: 1200, height: 800, frame: "browser" };

/** A page whose artboard `home.html` the terminal session rewrote ("Old title" then "New title"), and the same session adding `fresh.html`. */
async function published(): Promise<{ pageId: string }> {
  const page = await seam.createPage({ "home.html": "<!doctype html><h1>Old title</h1>", "manifest.json": JSON.stringify({ artboards: [HOME] }) }, "Site");
  await call(`/terminal-sessions/${SESSION}/heartbeat`, { folder: "/work/site", machine: "Mac" });
  const current = (await (await seam.server.get(`/api/pages/${page.id}`)).json()) as RedlinePage;
  await call(`/pages/${page.id}/versions`, {
    files: { "home.html": "<!doctype html><h1>New title</h1>", "fresh.html": "<!doctype html><h1>Fresh screen</h1>", "manifest.json": JSON.stringify({ artboards: [HOME, FRESH] }) },
    message: "Rewrite",
    origin: "terminal",
    baseVersionId: current.version.id,
    terminalSessionId: SESSION,
  });
  return { pageId: page.id };
}

async function declare(pageId: string): Promise<string> {
  const step = (artboard: string) => ({ pageId, artboard, changed: `The ${artboard} changed`, lookAt: "Look", question: "Fine?" });
  const response = await call(`/terminal-sessions/${SESSION}/reviews`, { folder: "/work/site", steps: [step("home.html"), step("fresh.html")] });
  return ((await response.json()) as { id: string }).id;
}

const artboardFrame = (tab: Page, file: string): Frame | undefined => tab.frames().find((frame) => frame.url().includes(`/${file}`));
const titleOf = (tab: Page, file: string) => artboardFrame(tab, file)?.evaluate(() => document.querySelector("h1")?.textContent ?? null).catch(() => null);
const top = (tab: Page) => tab.getByTestId("review-top");

it("toggles an artboard between its version before the series and the current one, and shows a new artboard as Après (nouveau) with Avant disabled", async () => {
  const { pageId } = await published();
  const reviewId = await declare(pageId);
  const tab = await browser.newPage({ viewport: { width: 1440, height: 900 } });
  await tab.goto(`${seam.server.url}/#/reviews/${reviewId}/steps/1`);

  const avant = top(tab).getByRole("button", { name: "Avant" });
  const apres = top(tab).getByRole("button", { name: "Après" });
  await expect.poll(() => titleOf(tab, "home.html")).toBe("New title");
  expect(await apres.getAttribute("aria-pressed")).toBe("true");

  await avant.click();
  await expect.poll(() => titleOf(tab, "home.html")).toBe("Old title");
  expect(await tab.getByTestId("review-before-tag").textContent()).toMatch(/^Avant · version du .+, avant la série$/);
  expect(await avant.getAttribute("aria-pressed")).toBe("true");

  await apres.click();
  await expect.poll(() => titleOf(tab, "home.html")).toBe("New title");
  expect(await tab.getByTestId("review-before-tag").count()).toBe(0);

  // The artboard created in the series has nothing before it.
  await tab.getByRole("button", { name: "Suivante →" }).click();
  await expect.poll(() => titleOf(tab, "fresh.html")).toBe("Fresh screen");
  expect(await top(tab).getByRole("button", { name: "Avant" }).isDisabled()).toBe(true);
  expect(await top(tab).getByRole("button", { name: "Après (nouveau)" }).getAttribute("aria-pressed")).toBe("true");
  await tab.close();
});
