import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { copyBuiltWeb } from "./builtWeb.js";
import { type Browser, type BrowserContext } from "playwright";
import { launchBrowser } from "./journeyBrowser.js";
import { afterAll, afterEach, beforeAll, expect, it } from "vitest";
import { CORE_TOKENS, MANIFEST_PATH } from "@redline/shared";
import { startTestServer, type TestServer } from "@redline/server/test-harness";

let server: TestServer;
let browser: Browser;
let webDir: string;
let context: BrowserContext;

beforeAll(async () => {
  webDir = mkdtempSync(join(tmpdir(), "redline-web-"));
  copyBuiltWeb(webDir);
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
const modalWithFooter = `<!doctype html><html><body><template data-component><div class="modal"><slot></slot><footer><slot name="footer"></slot></footer></div></template></body></html>`;
const sizeTweak = { id: "size", type: "choice", label: "Size", options: ["sm", "md"], default: "md", artboard: "components/modal.html" };
const dsManifest = (tweak: object) => JSON.stringify({ artboards: [{ file: "components/modal.html", x: 0, y: 0, width: 200, height: 100 }], tweaks: [tweak] });

it("lists a broken instance in the Erreurs des artboards popover with its reason", async () => {
  const designSystem = (await (
    await server.post("/api/design-systems", {
      title: "Acme DS",
      files: {
        "tokens.css": tokensCss,
        [MANIFEST_PATH]: dsManifest({ ...sizeTweak, options: ["sm", "md", "xl"] }),
        "components/modal.html": modalWithFooter,
      },
    })
  ).json()) as { id: string; pageId: string };
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
  // Publishing refuses a broken instance: the page breaks when a later diffusion drops the value and the slot it uses.
  const removal = await server.post(`/api/pages/${designSystem.pageId}/versions`, {
    files: { "tokens.css": tokensCss, [MANIFEST_PATH]: dsManifest(sizeTweak), "components/modal.html": modal },
    message: "Drop xl and footer",
    origin: "thread",
    confirmRemovals: true,
  });
  expect(removal.ok).toBe(true);
  expect((await server.post(`/api/design-systems/${designSystem.id}/diffusions`, {})).ok).toBe(true);

  const tab = await context.newPage();
  await tab.goto(`${server.url}/#/pages/${page.id}`);
  const button = tab.getByTestId("errors-button");
  await expect.poll(() => button.innerText()).toBe("2 erreurs");
  await button.click();
  const list = tab.getByRole("dialog", { name: "Erreurs des artboards" });
  await list.waitFor();
  if (process.env.REDLINE_CAPTURES) await list.screenshot({ path: join(process.env.REDLINE_CAPTURES, "fix-broken-app-popover.png") });
  const row = await list.locator('[data-errors-of="a.html"]').innerText();
  expect(row).toContain("ui-modal : la valeur xl du réglage size n'existe plus depuis la diffusion 2. Affichée avec la valeur par défaut (md).");
  expect(row).toContain("ui-modal : l'emplacement footer n'existe plus. Son contenu n'est pas affiché.");
}, 60_000);
