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

it("shows Habillage, Repères and Tweaks as icon buttons with a tooltip, and the top bar never overlaps at 1440 px with every control", async () => {
  const { reviewId } = await declare((id) => [step(id, "meeting.html", { targets: ["h1"], tweaks: { state: "ready" } })]);
  const tab = await browser.newPage({ viewport: { width: 1440, height: 900 } });
  await tab.goto(`${seam.server.url}/#/reviews/${reviewId}/steps/1`);

  for (const [name, tooltip] of [["Habillage", "Habillage : afficher ou masquer"], ["Repères", "Repères : afficher ou masquer"], ["Tweaks", "Tweaks : régler"]] as const) {
    const button = top(tab).getByRole("button", { name });
    await button.waitFor();
    expect(await button.getAttribute("title")).toContain(tooltip);
    expect(await button.textContent()).toBe("");
    expect((await button.boundingBox())!.width).toBe(36);
  }
  await top(tab).getByRole("button", { name: "Terminer la revue" }).waitFor();
  const boxes = await top(tab).locator("button, [data-testid='review-title']").evaluateAll((nodes) => nodes.map((node) => node.getBoundingClientRect()).filter((box) => box.width > 0));
  for (const [index, box] of boxes.entries()) {
    for (const other of boxes.slice(index + 1)) {
      const overlaps = box.left < other.right - 0.5 && other.left < box.right - 0.5 && box.top < other.bottom - 0.5 && other.top < box.bottom - 0.5;
      expect(overlaps).toBe(false);
    }
  }
  await tab.close();
});

it("frames the elements Claude points at, numbered in the declared order, and nothing on a step without targets", async () => {
  const { reviewId } = await declare((id) => [step(id, "meeting.html", { targets: ["#missing", "h1"] }), step(id, "plain.html")]);
  const tab = await browser.newPage({ viewport: { width: 1440, height: 900 } });
  await tab.goto(`${seam.server.url}/#/reviews/${reviewId}/steps/1`);

  const badges = (file: string) => artboardFrame(tab, file)?.evaluate(() => Array.from(document.querySelectorAll("#__redline-compare [data-part='badge']"), (badge) => badge.textContent)).catch(() => null);
  // An element that is not on the artboard is skipped: the others keep their number.
  await expect.poll(() => badges("meeting.html")).toEqual(["2"]);

  // "Repères" hides the frames and shows them again; the choice stays for the next steps.
  const markers = top(tab).getByRole("button", { name: "Repères" });
  expect(await markers.getAttribute("aria-pressed")).toBe("true");
  await markers.click();
  await expect.poll(() => badges("meeting.html")).toEqual([]);
  expect(await markers.getAttribute("aria-pressed")).toBe("false");
  await markers.click();
  await expect.poll(() => badges("meeting.html")).toEqual(["2"]);

  await tab.getByRole("button", { name: "Suivante →" }).click();
  await expect.poll(() => counter(tab).textContent()).toContain("Étape 2 / 2");
  await expect.poll(() => artboardFrame(tab, "plain.html")?.evaluate(() => document.readyState).catch(() => null)).toBe("complete");
  await new Promise((resolve) => setTimeout(resolve, 300));
  expect(await badges("plain.html")).toEqual([]);
  expect(await top(tab).getByRole("button", { name: "Repères" }).count()).toBe(0);
  await tab.close();
});

