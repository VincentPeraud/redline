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

const answeringEngine = () =>
  new FakeEngine((run) => [
    ...[...run.message.matchAll(/thread id: ([0-9a-f-]{36})\)/g)].map((m) => ({ replyInThread: { threadId: m[1], text: "Agent answer" } })),
    { type: "result" as const, summary: "Agent run" },
  ]);

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

/** A page in Conversation mode with two threads to take, opened on its Commentaires tab. */
async function openedPage(engine = answeringEngine()): Promise<{ tab: Tab; pageId: string; engine: FakeEngine }> {
  seam = await startSeam2(engine, { webDir });
  const page = await seam.createPage(FILES, "Partager", "conversation");
  await seam.pinThread(page.id, "home.html", "Make the title blue");
  await seam.pinThread(page.id, "home.html", "Bigger button");
  const tab = await browser.newPage({ viewport: { width: 1440, height: 900 } });
  openTab = tab;
  await tab.goto(`${seam.server.url}/#/pages/${page.id}`);
  await tab.getByRole("tab", { name: /^Commentaires/ }).click();
  await expect.poll(() => tab.locator('[data-handler="to-take"]').count()).toBe(2);
  return { tab, pageId: page.id, engine };
}

const toggle = (tab: Tab) => tab.getByTestId("comment-mode");
const pressed = async (tab: Tab) => (await toggle(tab).locator("button[aria-pressed='true']").textContent())?.trim();

it("switches a page to Agent after a confirmation that counts the threads, and shows the hint of each mode", async () => {
  const { tab, engine } = await openedPage();
  expect(await pressed(tab)).toBe("Conversation");
  await expect.poll(() => tab.getByTestId("comment-hint").textContent()).toContain("2 commentaires à prendre. Dis « traite les commentaires de Partager » à une conversation Claude.");

  await toggle(tab).getByRole("button", { name: "Agent" }).click();
  const dialog = tab.getByRole("dialog", { name: "Passer la page en mode Agent" });
  await expect.poll(() => dialog.textContent()).toContain("Les nouveaux commentaires de « Partager » partiront tout de suite à l'agent du projet. Pour les 2 fils ouverts");
  expect(await dialog.textContent()).toContain("2fils à prendre partent à l'agent maintenant.");

  await dialog.getByRole("button", { name: "Annuler" }).click();
  await expect.poll(() => dialog.count()).toBe(0);
  expect(await pressed(tab)).toBe("Conversation");
  expect(engine.runs).toHaveLength(0);

  await toggle(tab).getByRole("button", { name: "Agent" }).click();
  await dialog.getByRole("button", { name: "Passer en mode Agent" }).click();
  await expect.poll(() => pressed(tab)).toBe("Agent");
  await expect.poll(() => tab.getByTestId("comment-hint").textContent()).toContain("Mode Agent. Les nouveaux commentaires partent tout de suite à l'agent du projet.");
  await expect.poll(() => tab.getByTestId("reply").count()).toBeGreaterThan(0);
  expect(engine.runs.length).toBeGreaterThan(0);
}, 60_000);

it("with the agent offline, the threads wait visibly, and going back to Conversation says how many are to take again, without a confirmation", async () => {
  const { tab, pageId } = await openedPage();
  seam!.agent.close();
  await waitUntilOffline(seam!);

  await toggle(tab).getByRole("button", { name: "Agent" }).click();
  const dialog = tab.getByRole("dialog", { name: "Passer la page en mode Agent" });
  await expect.poll(() => dialog.textContent()).toContain("L'agent du projet ne tourne pas. Les commentaires attendront son retour");
  expect(await dialog.textContent()).toContain("2fils à prendre passent en attente de l'agent.");
  await dialog.getByRole("button", { name: "Passer en mode Agent" }).click();

  await expect.poll(() => tab.locator('[data-handler="to-take"]').count()).toBe(0);
  await expect.poll(() => tab.getByTestId("agent-wait").count()).toBe(2);
  expect(await tab.getByTestId("agent-wait").first().textContent()).toContain("L'agent du projet ne tourne pas : il traitera ce fil à son retour. Une conversation peut aussi le prendre.");
  expect(await tab.getByText("En attente de l'agent (hors ligne)").count()).toBe(2);

  await toggle(tab).getByRole("button", { name: "Conversation" }).click();
  await expect.poll(() => pressed(tab)).toBe("Conversation");
  expect(await tab.getByRole("dialog").count()).toBe(0);
  const toast = tab.getByRole("status").filter({ hasText: "Page repassée en mode Conversation" });
  await expect.poll(() => toast.textContent()).toContain("2 fils en attente de l'agent redeviennent à prendre. Ceux qu'il a commencés lui restent.");
  await expect.poll(() => tab.locator('[data-handler="to-take"]').count()).toBe(2);
  expect(await tab.getByTestId("agent-wait").count()).toBe(0);
  const page = (await (await seam!.server.get(`/api/pages/${pageId}`)).json()) as { commentMode: string };
  expect(page.commentMode).toBe("conversation");
}, 60_000);

it("a toast closes by itself", async () => {
  const { tab } = await openedPage();
  seam!.agent.close();
  await waitUntilOffline(seam!);
  await toggle(tab).getByRole("button", { name: "Agent" }).click();
  await tab.getByRole("button", { name: "Passer en mode Agent" }).click();
  await expect.poll(() => pressed(tab)).toBe("Agent");
  await toggle(tab).getByRole("button", { name: "Conversation" }).click();
  const toast = tab.getByRole("status").filter({ hasText: "Page repassée en mode Conversation" });
  await expect.poll(() => toast.count()).toBe(1);
  await expect.poll(() => toast.count(), { timeout: 15_000 }).toBe(0);
}, 60_000);

it("the label opens an explanation of both modes", async () => {
  const { tab } = await openedPage();

  await tab.getByRole("button", { name: "Commentaires", exact: true }).click();

  const popover = tab.getByRole("dialog", { name: "Qui traite les commentaires" });
  const text = (await popover.textContent()) ?? "";
  expect(text).toContain("Qui traite les commentaires de cette page");
  expect(text).toContain("Conversation : les commentaires attendent.");
  expect(text).toContain("Agent : chaque commentaire part tout de suite à l'agent du projet, qui le traite seul.");
  expect(text).toContain("« Confier à l'agent » sur un fil l'envoie à l'agent sans changer le mode de la page.");
  await tab.keyboard.press("Escape");
  await expect.poll(() => popover.count()).toBe(0);
}, 60_000);

it("on a phone the toggle sits at the top of the comments panel, full width, with its explanation behind an ⓘ", async () => {
  const { tab } = await openedPage();
  await tab.setViewportSize({ width: 390, height: 844 });
  await tab.getByTestId("comments-opener").click();

  const panelToggle = tab.getByTestId("comment-mode-phone");
  await expect.poll(() => panelToggle.isVisible()).toBe(true);
  expect(await toggle(tab).isVisible()).toBe(false);
  const box = (await panelToggle.getByRole("button", { name: "Agent" }).boundingBox())!;
  expect(box.height).toBeGreaterThanOrEqual(40);
  await tab.getByRole("button", { name: /Qui traite les commentaires/ }).click();
  await expect.poll(() => tab.getByRole("dialog", { name: "Qui traite les commentaires" }).count()).toBe(1);
}, 60_000);
