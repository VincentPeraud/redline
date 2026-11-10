import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { build } from "vite";
import { type Browser, type BrowserContext } from "playwright";
import { launchBrowser } from "./journeyBrowser.js";
import { afterAll, afterEach, beforeAll, expect, it } from "vitest";
import { MANIFEST_PATH, parseManifest } from "@redline/shared";
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

const clean = `<!doctype html><html><body style="margin:0"><h1>Accueil</h1></body></html>`;
const broken = [
  `<!doctype html><html><body style="margin:0">`,
  `<h1>Paiement</h1>`,
  `<img src="assets/hero.jpg" alt="">`,
  `<script>`,
  `const plans = undefined;`,
  `plans.map((plan) => plan);`,
  `</script>`,
  `</body></html>`,
].join("\n");
const tall = (height: number) => `<!doctype html><html><body style="margin:0"><div style="height: ${height}px; background: #fde3df">Landing</div></body></html>`;

async function createPage(files: Record<string, string>, artboards: unknown[]): Promise<string> {
  const project = (await (await server.post("/api/projects", { title: "Lumora" })).json()) as { id: string };
  const page = (await (await server.post(`/api/projects/${project.id}/pages`, { title: "Onboarding", files: { ...files, [MANIFEST_PATH]: JSON.stringify({ artboards }) } })).json()) as { id: string };
  return page.id;
}

it("counts the errors of the artboards in the header and on the strip, lists them, and Voir centres the canvas on the artboard", async () => {
  const pageId = await createPage({ "accueil.html": clean, "paiement.html": broken }, [
    { file: "accueil.html", title: "Accueil", x: 0, y: 0, width: 280, height: 420 },
    { file: "paiement.html", title: "Paiement", x: 2400, y: 600, width: 280, height: 420 },
  ]);
  const tab = await context.newPage();
  await tab.goto(`${server.url}/#/pages/${pageId}`);

  const button = tab.getByTestId("errors-button");
  await expect.poll(() => button.count()).toBe(1);
  await expect.poll(() => button.innerText()).toBe("2 erreurs");
  expect(await tab.locator('[data-strip="paiement.html"]').getByTestId("artboard-errors").innerText()).toBe("2 erreurs");
  expect(await tab.locator('[data-strip="accueil.html"]').getByTestId("artboard-errors").count()).toBe(0);

  await button.click();
  const list = tab.getByRole("dialog", { name: "Erreurs des artboards" });
  await list.waitFor();
  expect(await list.innerText()).toContain("Ces artboards ne s'affichent pas comme prévu.");
  const row = list.locator('[data-errors-of="paiement.html"]');
  expect(await row.innerText()).toContain("Paiement");
  expect(await row.innerText()).toContain("TypeError: Cannot read properties of undefined (reading 'map') · ligne 6");
  expect(await row.innerText()).toContain("Image introuvable : assets/hero.jpg");
  expect(await list.locator("[data-errors-of]").count()).toBe(1);

  await row.getByRole("button", { name: "Voir" }).click();
  await list.waitFor({ state: "detached" });
  await expect
    .poll(async () => {
      const viewport = (await tab.getByTestId("canvas").boundingBox())!;
      const artboard = (await tab.locator('[data-artboard="paiement.html"] iframe').boundingBox())!;
      return Math.abs(artboard.x + artboard.width / 2 - (viewport.x + viewport.width / 2));
    })
    .toBeLessThan(4);
}, 60_000);

it("Demander à Claude de corriger posts the errors in the page's conversation, and a fixed version clears the count", async () => {
  const pageId = await createPage({ "paiement.html": broken }, [{ file: "paiement.html", title: "Paiement", x: 0, y: 0, width: 280, height: 420 }]);
  const tab = await context.newPage();
  await tab.goto(`${server.url}/#/pages/${pageId}`);
  await expect.poll(() => tab.getByTestId("errors-button").innerText()).toBe("2 erreurs");
  await tab.getByTestId("errors-button").click();
  await tab.getByRole("dialog", { name: "Erreurs des artboards" }).getByRole("button", { name: "Demander à Claude de corriger" }).click();

  type Detail = { messages: { author: string; body: string }[] };
  const firstConversation = async () => {
    const [first] = (await (await server.get(`/api/pages/${pageId}/conversations`)).json()) as { id: string }[];
    return first ? ((await (await server.get(`/api/conversations/${first.id}`)).json()) as Detail) : null;
  };
  await expect.poll(async () => (await firstConversation())?.messages.length).toBe(1);
  const { author, body } = (await firstConversation())!.messages[0]!;
  expect(author).toBe("user");
  expect(body).toContain("Corrige ces 2 erreurs");
  expect(body).toContain("paiement.html :");
  expect(body).toContain("- Image introuvable : assets/hero.jpg");

  const manifest = await (await server.get(`/api/pages/${pageId}/files/${MANIFEST_PATH}`)).text();
  await server.post(`/api/pages/${pageId}/versions`, { files: { "paiement.html": clean, [MANIFEST_PATH]: manifest }, message: "Fix", origin: "terminal" });
  await expect.poll(() => tab.getByTestId("errors-button").count()).toBe(0);
  expect(await tab.getByTestId("artboard-errors").count()).toBe(0);
}, 60_000);

it('sizes a "fit" artboard to its page, so what is anchored below it follows', async () => {
  const pageId = await createPage({ "article.html": tall(2000) }, [{ file: "article.html", x: 0, y: 0, width: 600, height: "fit" }]);
  const tab = await context.newPage();
  await tab.goto(`${server.url}/#/pages/${pageId}`);
  const iframe = tab.locator('[data-artboard="article.html"] iframe');
  await iframe.waitFor();
  await expect.poll(async () => iframe.evaluate((el) => (el as HTMLIFrameElement).offsetHeight)).toBe(2000);
  expect(await tab.getByTestId("artboard-taller").count()).toBe(0);
}, 60_000);

it("leaves a fit artboard at its size when its page grows with the artboard itself", async () => {
  const growing = `<!doctype html><html><body style="margin:8px"><div style="min-height: 100vh">Landing</div></body></html>`;
  const pageId = await createPage({ "landing.html": growing }, [{ file: "landing.html", x: 0, y: 0, width: 600, height: "fit" }]);
  const tab = await context.newPage();
  await tab.goto(`${server.url}/#/pages/${pageId}`);
  const iframe = tab.locator('[data-artboard="landing.html"] iframe');
  await iframe.waitFor();
  await tab.waitForTimeout(1500);
  const settled = await iframe.evaluate((el) => (el as HTMLIFrameElement).offsetHeight);
  await tab.waitForTimeout(500);
  expect(await iframe.evaluate((el) => (el as HTMLIFrameElement).offsetHeight)).toBe(settled);
  expect(settled).toBeLessThan(1000);
}, 60_000);

it("flags a fixed artboard whose page is taller, and Ajuster la hauteur au contenu saves the measured height", async () => {
  const pageId = await createPage({ "landing.html": tall(3200), "accueil.html": clean }, [
    { file: "landing.html", title: "Landing", x: 0, y: 0, width: 600, height: 700 },
    { file: "accueil.html", title: "Accueil", x: 700, y: 0, width: 600, height: 700 },
  ]);
  const tab = await context.newPage();
  await tab.goto(`${server.url}/#/pages/${pageId}`);
  const hint = tab.locator('[data-strip="landing.html"]').getByTestId("artboard-taller");
  await hint.waitFor();
  expect((await hint.innerText()).replace(/\s/g, " ")).toBe("↕ 3 200 px");
  expect(await tab.locator('[data-strip="accueil.html"]').getByTestId("artboard-taller").count()).toBe(0);

  await tab.getByRole("button", { name: "Autres actions pour accueil.html" }).click();
  expect(await tab.getByRole("menuitem", { name: "Ajuster la hauteur au contenu" }).count()).toBe(0);
  await tab.keyboard.press("Escape");

  await tab.getByRole("button", { name: "Autres actions pour landing.html" }).click();
  await tab.getByRole("menuitem", { name: "Ajuster la hauteur au contenu" }).click();
  await hint.waitFor({ state: "detached" });
  const manifest = parseManifest(await (await server.get(`/api/pages/${pageId}/files/${MANIFEST_PATH}`)).text());
  expect(manifest.artboards[0]).toMatchObject({ file: "landing.html", height: 3200 });
  const iframe = tab.locator('[data-artboard="landing.html"] iframe');
  await expect.poll(async () => iframe.evaluate((el) => (el as HTMLIFrameElement).offsetHeight)).toBe(3200);
}, 60_000);
