import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { build } from "vite";
import { type Browser, type BrowserContext } from "playwright";
import { launchBrowser } from "./journeyBrowser.js";
import { afterAll, afterEach, beforeAll, expect, it } from "vitest";
import { CORE_TOKENS } from "@redline/shared";
import { startTestServer, type TestServer } from "@redline/server/test-harness";

const webRoot = fileURLToPath(new URL("..", import.meta.url));

let server: TestServer;
let browser: Browser;
let webDir: string;
let context: BrowserContext;

beforeAll(async () => {
  webDir = mkdtempSync(join(tmpdir(), "redline-web-"));
  await build({ root: webRoot, logLevel: "silent", build: { outDir: webDir, emptyOutDir: true } });
  server = await startTestServer({ webDir });
  browser = await launchBrowser();
  context = await browser.newContext({ viewport: { width: 1440, height: 900 } });
}, 60_000);

afterEach(async () => {
  await Promise.all(context.pages().map((page) => page.close()));
});

afterAll(async () => {
  await browser?.close();
  await server?.stop();
  rmSync(webDir, { recursive: true, force: true });
});

const tokensCss = `:root {\n${CORE_TOKENS.map((t) => `  ${t}: #111111;`).join("\n")}\n  --color-primary: #ff5a1f;\n  --color-accent: var(--color-highlight); /* deprecated: renamed to --color-highlight */\n  --color-highlight: #8b5cf6;\n}\n`;
const component = `<!doctype html><html><head><style data-component>.post-cta{color:red}</style></head><body></body></html>`;
const clean = `<!doctype html><html><body style="margin:0"><h1 style="color: var(--color-text)">Une nuit de garde</h1></body></html>`;
const drifting = `<!doctype html><html><body style="margin:0"><h1>Trouve ton remplaçant</h1><button id="cta" style="margin-top: 300px; background: #FF6B00; font-family: Arial">Lien en bio</button><p style="color: var(--color-accent)">x</p></body></html>`;
const manifest = (designSystem: string) =>
  JSON.stringify({
    designSystem,
    artboards: [
      { file: "story-1.html", title: "story-1.html", x: 0, y: 0, width: 220, height: 390 },
      { file: "story-2.html", title: "story-2.html", x: 2400, y: 600, width: 220, height: 390 },
    ],
  });

async function setup(files: Record<string, string>): Promise<string> {
  const ds = (await (await server.post("/api/design-systems", {
    title: "Lumora",
    files: {
      "tokens.css": tokensCss,
      "manifest.json": JSON.stringify({ artboards: [{ file: "components/post-cta.html", x: 0, y: 0, width: 200, height: 100 }] }),
      "components/post-cta.html": component,
    },
  })).json()) as { id: string };
  const project = (await (await server.post("/api/projects", { title: "Semaine Halloween", designSystem: ds.id })).json()) as { id: string };
  const page = (await (await server.post(`/api/projects/${project.id}/pages`, {
    title: "Stories",
    files: { ...files, "manifest.json": manifest(ds.id) },
  })).json()) as { id: string };
  return page.id;
}

it("shows the gaps of a page: header button, list, pill on the strip of the artboard that has them, and Voir outlines the element", async () => {
  const pageId = await setup({ "story-1.html": clean, "story-2.html": drifting });
  const tab = await context.newPage();
  await tab.goto(`${server.url}/#/pages/${pageId}`);

  const button = tab.getByTestId("gaps-button");
  await button.waitFor();
  expect(await button.innerText()).toBe("4 écarts");
  const pill = tab.locator('[data-strip="story-2.html"]').getByTestId("artboard-gaps");
  await pill.waitFor();
  expect(await pill.innerText()).toBe("4 écarts");
  expect(await tab.locator('[data-strip="story-1.html"]').getByTestId("artboard-gaps").count()).toBe(0);

  await button.click();
  const list = tab.getByRole("dialog", { name: "Écarts au design system" });
  await list.waitFor();
  const text = async (selector: string) => (await list.locator(selector).innerText()).replace(/\s+/g, " ");
  expect(await list.innerText()).toContain("4 écarts au design system");
  expect(await list.innerText()).toContain("Ce qui n'utilise ni les tokens ni les composants de Lumora et du style du projet. Rien n'est bloqué.");
  expect(await text('[data-gap-kind="color"]')).toContain("Couleur en dur #FF6B00 sur un bouton");
  expect(await text('[data-gap-kind="color"]')).toContain("Proche de --color-primary · un post-cta existe pour ce cas");
  expect(await text('[data-gap-kind="font"]')).toContain("Police en dur « Arial »");
  expect(await text('[data-gap-kind="font"]')).toContain("Au lieu de --font-body");
  expect(await text('[data-gap-kind="deprecated"]')).toContain("déprécié");
  expect(await text('[data-gap-kind="deprecated"]')).toContain("Utilise --color-accent");
  expect(await text('[data-gap-kind="deprecated"]')).toContain("Renommé en --color-highlight");
  expect(await list.locator("[data-gap]").first().innerText()).toContain("story-2.html");

  await list.locator('[data-gap-kind="color"]').getByRole("button", { name: "Voir" }).click();
  await list.waitFor({ state: "detached" });
  const frame = tab.frames().find((f) => f.url().endsWith("/story-2.html"))!;
  await frame.locator("#__redline-gap").waitFor({ state: "attached" });
  expect(await frame.locator("#__redline-gap").evaluate((el) => getComputedStyle(el).outlineStyle)).toBe("dashed");

  // The canvas is centred on the element: its middle is the middle of the canvas.
  await expect
    .poll(async () => {
      const viewport = (await tab.getByTestId("canvas").boundingBox())!;
      const element = (await frame.locator("#cta").boundingBox())!;
      return Math.max(Math.abs(element.x + element.width / 2 - (viewport.x + viewport.width / 2)), Math.abs(element.y + element.height / 2 - (viewport.y + viewport.height / 2)));
    })
    .toBeLessThan(4);

  await tab.getByTestId("canvas").click({ position: { x: 20, y: 20 } });
  await expect.poll(() => frame.locator("#__redline-gap").count()).toBe(0);
}, 60_000);

it("shows no button and no pill on a page without gaps", async () => {
  const pageId = await setup({ "story-1.html": clean, "story-2.html": clean });
  const tab = await context.newPage();
  await tab.goto(`${server.url}/#/pages/${pageId}`);
  await tab.locator('[data-strip="story-2.html"]').waitFor();
  await tab.waitForTimeout(500);
  expect(await tab.getByTestId("gaps-button").count()).toBe(0);
  expect(await tab.getByTestId("artboard-gaps").count()).toBe(0);
}, 60_000);

it("shows no button and no pill on a page of a project without a design system, even with hard-coded colours and fonts", async () => {
  const project = (await (await server.post("/api/projects", { title: "Radio" })).json()) as { id: string };
  const page = (await (await server.post(`/api/projects/${project.id}/pages`, {
    title: "Rejeu",
    files: { "story-2.html": drifting, "manifest.json": JSON.stringify({ artboards: [{ file: "story-2.html", title: "story-2.html", x: 0, y: 0, width: 220, height: 390 }] }) },
  })).json()) as { id: string };
  const tab = await context.newPage();
  await tab.goto(`${server.url}/#/pages/${page.id}`);
  await tab.locator('[data-strip="story-2.html"]').waitFor();
  await tab.waitForTimeout(500);
  expect(await tab.getByTestId("gaps-button").count()).toBe(0);
  expect(await tab.getByTestId("artboard-gaps").count()).toBe(0);
}, 60_000);

it("Exception voulue hides a gap for good: counts, footer, pill and a reload all follow", async () => {
  const pageId = await setup({ "story-1.html": clean, "story-2.html": drifting });
  const tab = await context.newPage();
  await tab.goto(`${server.url}/#/pages/${pageId}`);
  await tab.getByTestId("gaps-button").click();
  const list = tab.getByRole("dialog", { name: "Écarts au design system" });
  expect(await list.innerText()).not.toContain("masquée");

  await list.locator('[data-gap-kind="font"]').getByRole("button", { name: "Exception voulue" }).click();
  await list.locator('[data-gap-kind="font"]').waitFor({ state: "detached" });
  expect(await list.innerText()).toContain("3 écarts au design system");
  expect(await list.innerText()).toContain("1 exception voulue masquée");
  expect(await tab.getByTestId("gaps-button").innerText()).toBe("3 écarts");
  expect(await tab.locator('[data-strip="story-2.html"]').getByTestId("artboard-gaps").innerText()).toBe("3 écarts");

  await list.locator('[data-gap-kind="deprecated"]').getByRole("button", { name: "Exception voulue" }).click();
  await expect.poll(async () => list.innerText()).toContain("2 exceptions voulues masquées");

  const reloaded = await context.newPage();
  await reloaded.goto(`${server.url}/#/pages/${pageId}`);
  await reloaded.getByTestId("gaps-button").waitFor();
  expect(await reloaded.getByTestId("gaps-button").innerText()).toBe("2 écarts");
  const versions = (await (await server.get(`/api/pages/${pageId}/versions`)).json()) as unknown[];
  expect(versions).toHaveLength(1);
}, 60_000);

it("Demander à Claude de corriger posts the visible gaps, not the exceptions, in the page's conversation", async () => {
  const pageId = await setup({ "story-1.html": clean, "story-2.html": drifting });
  const tab = await context.newPage();
  await tab.goto(`${server.url}/#/pages/${pageId}`);
  await tab.getByTestId("gaps-button").click();
  const list = tab.getByRole("dialog", { name: "Écarts au design system" });
  await list.locator('[data-gap-kind="font"]').getByRole("button", { name: "Exception voulue" }).click();
  await list.getByRole("button", { name: "Demander à Claude de corriger" }).click();
  await list.waitFor({ state: "detached" });

  type Detail = { messages: { author: string; body: string }[] };
  const firstConversation = async () => {
    const [first] = (await (await server.get(`/api/pages/${pageId}/conversations`)).json()) as { id: string }[];
    return first ? ((await (await server.get(`/api/conversations/${first.id}`)).json()) as Detail) : null;
  };
  await expect.poll(async () => (await firstConversation())?.messages.length).toBe(1);
  const detail = (await firstConversation())!;
  const { author, body } = detail.messages[0]!;
  expect(author).toBe("user");
  expect(body).toContain("story-2.html");
  expect(body).toContain("Couleur en dur #FF6B00 sur un bouton");
  expect(body).toContain("--color-highlight");
  expect(body).not.toContain("Arial");
  expect(body).toContain("data-ds-libre");
  await tab.getByTestId("conversations").getByText("Couleur en dur #FF6B00 sur un bouton").first().waitFor();
}, 60_000);

it("keeps the button when every gap is an exception, and Réafficher brings the exceptions back", async () => {
  const pageId = await setup({ "story-1.html": clean, "story-2.html": drifting });
  const tab = await context.newPage();
  await tab.goto(`${server.url}/#/pages/${pageId}`);
  await tab.getByTestId("gaps-button").click();
  const list = tab.getByRole("dialog", { name: "Écarts au design system" });
  for (let remaining = 4; remaining > 0; remaining--) {
    await list.locator("[data-gap]").first().getByRole("button", { name: "Exception voulue" }).click();
    await expect.poll(() => list.locator("[data-gap]").count()).toBe(remaining - 1);
  }
  expect(await list.innerText()).toContain("0 écart au design system");
  expect(await list.innerText()).toContain("4 exceptions voulues masquées");
  expect(await list.getByRole("button", { name: "Demander à Claude de corriger" }).isDisabled()).toBe(true);
  expect(await tab.getByTestId("gaps-button").innerText()).toBe("0 écart");

  await list.getByRole("button", { name: "Réafficher" }).click();
  await expect.poll(() => list.locator("[data-gap]").count()).toBe(4);
  expect(await list.innerText()).not.toContain("masquée");
  expect(await tab.getByTestId("gaps-button").innerText()).toBe("4 écarts");
}, 60_000);

it("Demander à Claude de corriger shows the conversation that received the message, even when another one was open", async () => {
  const pageId = await setup({ "story-1.html": clean, "story-2.html": drifting });
  const post = (path: string, body: object) => server.post(path, body);
  const older = (await (await post(`/api/pages/${pageId}/conversations`, {})).json()) as { id: string };
  await post(`/api/conversations/${older.id}/messages`, { body: "Ancienne discussion" });
  await new Promise((resolve) => setTimeout(resolve, 20));
  const newer = (await (await post(`/api/pages/${pageId}/conversations`, {})).json()) as { id: string };
  await post(`/api/conversations/${newer.id}/messages`, { body: "Discussion récente" });

  const tab = await context.newPage();
  await tab.goto(`${server.url}/#/pages/${pageId}`);
  const panel = tab.getByTestId("conversations");
  await panel.getByTestId("conversation-message").first().waitFor();
  await panel.getByRole("button", { name: "Conversation", exact: true }).click();
  await panel.getByRole("option").nth(1).click();
  await expect.poll(() => panel.getByTestId("conversation-message").first().textContent()).toBe("Ancienne discussion");

  await tab.getByTestId("gaps-button").click();
  await tab.getByRole("dialog", { name: "Écarts au design system" }).getByRole("button", { name: "Demander à Claude de corriger" }).click();
  await expect.poll(() => panel.getByTestId("conversation-message").allTextContents().then((all) => all.some((text) => text.includes("Couleur en dur #FF6B00")))).toBe(true);
}, 60_000);
