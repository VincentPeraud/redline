import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { copyBuiltWeb } from "./builtWeb.js";
import { type Browser, type Frame, type Page } from "playwright";
import { launchBrowser } from "./journeyBrowser.js";
import { afterAll, beforeAll, expect, it } from "vitest";
import { FakeEngine, startSeam2, type Seam2 } from "@redline/agent/seam2";
import type { AgentTokenResponse } from "@redline/shared";

let browser: Browser;
let webDir: string;
let seam: Seam2;

beforeAll(async () => {
  webDir = mkdtempSync(join(tmpdir(), "redline-web-"));
  copyBuiltWeb(webDir);
  seam = await startSeam2(new FakeEngine(() => []), { webDir });
  browser = await launchBrowser();
}, 60_000);

afterAll(async () => {
  await browser?.close();
  await seam?.stop();
  rmSync(webDir, { recursive: true, force: true });
});

const MANIFEST = JSON.stringify({
  artboards: [
    {
      file: "meeting.html",
      title: "Meeting",
      x: 0,
      y: 0,
      width: 1200,
      height: 800,
      responsive: [
        { format: "desktop", width: 1200, height: 800 },
        { format: "mobile", width: 390, height: 760 },
      ],
    },
    { file: "plain.html", title: "Plain", x: 1300, y: 0, width: 1200, height: 800, frame: "browser" },
  ],
  tweaks: [{ id: "state", type: "choice", label: "State", options: ["idle", "ready", "failed"], artboard: "meeting.html" }],
});

const HEARTBEAT = "7d6f3f6e-0000-4000-8000-000000000010";

async function declare(steps: (pageId: string) => Record<string, unknown>[]): Promise<{ reviewId: string; pageId: string }> {
  const page = await seam.createPage({ "meeting.html": "<!doctype html><h1>Meeting screen</h1>", "plain.html": "<!doctype html><h1>Plain screen</h1>", "manifest.json": MANIFEST }, "Home");
  const { token } = (await (await seam.server.get("/api/agent-token")).json()) as AgentTokenResponse;
  const headers = { authorization: `Bearer ${token}`, "content-type": "application/json" };
  await fetch(`${seam.server.url}/agent-api/terminal-sessions/${HEARTBEAT}/heartbeat`, { method: "POST", headers, body: JSON.stringify({ folder: "/work/site", machine: "Mac" }) });
  const response = await fetch(`${seam.server.url}/agent-api/terminal-sessions/${HEARTBEAT}/reviews`, {
    method: "POST",
    headers,
    body: JSON.stringify({ folder: `/work/${page.id}/site`, steps: steps(page.id) }),
  });
  return { reviewId: ((await response.json()) as { id: string }).id, pageId: page.id };
}

const step = (pageId: string, artboard: string, extra: Record<string, unknown> = {}) => ({ pageId, artboard, changed: `The ${artboard} changed`, lookAt: `Look at ${artboard}`, question: `Is ${artboard} fine?`, ...extra });
const artboardFrame = (tab: Page, file: string): Frame | undefined => tab.frames().find((frame) => frame.url().includes(`/${file}`));
const stateOf = (tab: Page, file: string) => artboardFrame(tab, file)?.evaluate(() => document.documentElement.getAttribute("data-tweak-state")).catch(() => null);
const top = (tab: Page) => tab.getByTestId("review-top");
const counter = (tab: Page) => tab.getByRole("button", { name: /^Étape \d+ \/ \d+/ });

it("opens a step with Claude's values, keeps the reviewer's changes on this screen only and shows two states of one artboard as two steps", async () => {
  const { reviewId, pageId } = await declare((id) => [step(id, "meeting.html", { tweaks: { state: "ready" } }), step(id, "meeting.html", { tweaks: { state: "failed" } })]);
  const versionsBefore = (await seam.versions(pageId)).length;
  const tab = await browser.newPage({ viewport: { width: 1440, height: 900 } });
  await tab.goto(`${seam.server.url}/#/reviews/${reviewId}/steps/1`);

  await expect.poll(() => stateOf(tab, "meeting.html")).toBe("ready");
  const panel = tab.getByRole("complementary", { name: "Question de l'étape" });
  expect(await panel.textContent()).toContain("État affiché : « State : ready », fixé par Claude. Les autres états restent dans Tweaks.");

  // The Tweaks panel opens over the stage: the artboard keeps its place and size.
  const frameBox = () => tab.locator("iframe[title='Revue / meeting.html']").boundingBox();
  const closed = await frameBox();
  await top(tab).getByRole("button", { name: "Tweaks" }).click();
  await tab.getByRole("complementary", { name: "Tweaks" }).waitFor();
  expect(await frameBox()).toEqual(closed);

  // The reviewer looks at another state: it shows, and nothing is saved on the page.
  await tab.getByRole("complementary", { name: "Tweaks" }).getByRole("button", { name: "idle" }).click();
  await expect.poll(() => stateOf(tab, "meeting.html")).toBe("idle");
  await new Promise((resolve) => setTimeout(resolve, 600));
  expect(await seam.versions(pageId)).toHaveLength(versionsBefore);

  // The second step is the same artboard in another state, and the first keeps the reviewer's choice.
  await tab.getByRole("button", { name: "Suivante →" }).click();
  await expect.poll(() => counter(tab).textContent()).toContain("Étape 2 / 2");
  await expect.poll(() => stateOf(tab, "meeting.html")).toBe("failed");
  await tab.getByRole("button", { name: "← Précédente" }).click();
  await expect.poll(() => stateOf(tab, "meeting.html")).toBe("idle");
  await tab.close();
});

it("opens a mobile step in the mobile rendering and hides the toggle and the Tweaks button where they do not apply", async () => {
  const { reviewId } = await declare((id) => [step(id, "meeting.html", { mobile: true }), step(id, "plain.html")]);
  const tab = await browser.newPage({ viewport: { width: 1440, height: 900 } });
  await tab.goto(`${seam.server.url}/#/reviews/${reviewId}/steps/1`);

  const mobile = top(tab).getByRole("button", { name: "Mobile" });
  await expect.poll(() => mobile.getAttribute("aria-pressed")).toBe("true");
  expect(await top(tab).getByRole("button", { name: "Desktop" }).getAttribute("aria-pressed")).toBe("false");
  expect(await tab.getByRole("complementary", { name: "Question de l'étape" }).textContent()).toContain("À regarder en mobile");
  await expect.poll(async () => (await tab.locator("iframe[title='Revue / meeting.html']").boundingBox())?.width ?? 0).toBeLessThan(400);

  await top(tab).getByRole("button", { name: "Desktop" }).click();
  await expect.poll(() => top(tab).getByRole("button", { name: "Desktop" }).getAttribute("aria-pressed")).toBe("true");

  await tab.getByRole("button", { name: "Suivante →" }).click();
  await expect.poll(() => counter(tab).textContent()).toContain("Étape 2 / 2");
  expect(await top(tab).getByRole("group", { name: "Rendu" }).count()).toBe(0);
  expect(await top(tab).getByRole("button", { name: "Tweaks" }).count()).toBe(0);
  await tab.close();
});

it("shows and hides the device frame with Habillage, as in Present", async () => {
  const { reviewId } = await declare((id) => [step(id, "plain.html")]);
  const tab = await browser.newPage({ viewport: { width: 1440, height: 900 } });
  await tab.goto(`${seam.server.url}/#/reviews/${reviewId}/steps/1`);

  const habillage = top(tab).getByRole("button", { name: "Habillage" });
  await expect.poll(() => habillage.getAttribute("aria-pressed")).toBe("true");
  await expect.poll(() => tab.locator("[data-frame='browser']").count()).toBe(1);

  await habillage.click();
  await expect.poll(() => habillage.getAttribute("aria-pressed")).toBe("false");
  await expect.poll(() => tab.locator("[data-frame='browser']").count()).toBe(0);
  await habillage.click();
  await tab.close();
});
