import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { build } from "vite";
import { type Browser, type BrowserContext } from "playwright";
import { launchBrowser } from "./journeyBrowser.js";
import { afterAll, afterEach, beforeAll, expect, it } from "vitest";
import { CORE_TOKENS, MANIFEST_PATH } from "@redline/shared";
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

const tokensCss = `:root {\n${CORE_TOKENS.map((t) => `  ${t}: #000;`).join("\n")}\n}\n`;
const modal = `<!doctype html><html><body><template data-component><div class="modal"><slot></slot></div></template></body></html>`;
const sizeTweak = { id: "size", type: "choice", label: "Size", options: ["sm", "md"], default: "md", artboard: "components/modal.html" };

it("lists a broken instance in the Erreurs des artboards popover with its reason", async () => {
  const designSystem = (await (
    await server.post("/api/design-systems", {
      title: "Acme DS",
      files: {
        "tokens.css": tokensCss,
        [MANIFEST_PATH]: JSON.stringify({ artboards: [{ file: "components/modal.html", x: 0, y: 0, width: 200, height: 100 }], tweaks: [sizeTweak] }),
        "components/modal.html": modal,
      },
    })
  ).json()) as { id: string };
  const project = (await (await server.post("/api/projects", { title: "Acme" })).json()) as { id: string };
  const body = `<ui-modal size="xl"><span slot="footer">Bye</span><p>Hello</p></ui-modal>`;
  const page = (await (
    await server.post(`/api/projects/${project.id}/pages`, {
      title: "Flow",
      files: {
        [MANIFEST_PATH]: JSON.stringify({ designSystem: designSystem.id, artboards: [{ file: "a.html", title: "Accueil", x: 0, y: 0, width: 280, height: 420 }] }),
        "a.html": `<!doctype html><html><body style="margin:0">${body}</body></html>`,
      },
    })
  ).json()) as { id: string };

  const tab = await context.newPage();
  await tab.goto(`${server.url}/#/pages/${page.id}`);
  const button = tab.getByTestId("errors-button");
  await expect.poll(() => button.innerText()).toBe("2 erreurs");
  await button.click();
  const list = tab.getByRole("dialog", { name: "Erreurs des artboards" });
  await list.waitFor();
  const row = await list.locator('[data-errors-of="a.html"]').innerText();
  expect(row).toContain("ui-modal : la valeur xl du réglage size n'existe plus, affichée en md");
  expect(row).toContain("ui-modal : l'emplacement footer n'existe plus");
}, 60_000);
