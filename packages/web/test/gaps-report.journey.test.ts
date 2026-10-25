import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { build } from "vite";
import { chromium, type Browser, type BrowserContext } from "playwright";
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
  browser = await chromium.launch();
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
