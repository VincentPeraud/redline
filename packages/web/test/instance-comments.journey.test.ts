import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { copyBuiltWeb } from "./builtWeb.js";
import { type Browser } from "playwright";
import { launchBrowser } from "./journeyBrowser.js";
import { afterAll, beforeAll, expect, it } from "vitest";
import { CORE_TOKENS, type DesignSystem, type Page, type Thread } from "@redline/shared";
import { startTestServer, type TestServer } from "@redline/server/test-harness";

let server: TestServer;
let browser: Browser;
let webDir: string;

beforeAll(async () => {
  webDir = mkdtempSync(join(tmpdir(), "redline-web-"));
  copyBuiltWeb(webDir);
  server = await startTestServer({ webDir });
  browser = await launchBrowser();
}, 60_000);

afterAll(async () => {
  await browser?.close();
  await server?.stop();
  rmSync(webDir, { recursive: true, force: true });
});

const tokensCss = `:root {\n${CORE_TOKENS.map((t) => `  ${t}: #000;`).join("\n")}\n}\n`;
const modalFile = (template: string) => `<!doctype html><html><head></head><body><template data-component>${template}</template></body></html>`;
const MODAL = modalFile(`<div style="padding:16px;border:1px solid #ccc"><slot></slot><footer><button id="x" class="close">Close</button><button class="ok">OK</button></footer></div>`);
const MODAL_WITHOUT_FOOTER = modalFile(`<div style="padding:16px;border:1px solid #ccc"><slot></slot></div>`);
const MODAL_MANIFEST = JSON.stringify({ artboards: [{ file: "components/modal.html", x: 0, y: 0, width: 200, height: 100 }] });

it("pins a comment on an element inside an instance, says so on the card, and moves the pin onto the instance when the element is gone", async () => {
  const ds = (await (await server.post("/api/design-systems", { title: "Acme DS", files: { "tokens.css": tokensCss, "manifest.json": MODAL_MANIFEST, "components/modal.html": MODAL } })).json()) as DesignSystem;
  const project = (await (await server.post("/api/projects", { title: "Acme" })).json()) as { id: string };
  const page = (await (
    await server.post(`/api/projects/${project.id}/pages`, {
      title: "Planning",
      files: {
        "manifest.json": JSON.stringify({ designSystem: ds.id, artboards: [{ file: "a.html", title: "Planning", x: 0, y: 0, width: 600, height: 500 }] }),
        "a.html": `<!doctype html><body style="margin:0;font-family:sans-serif"><h1>Planning</h1><ui-modal id="confirm"><p>Really?</p></ui-modal></body>`,
      },
    })
  ).json()) as Page;
  const created = (await (
    await server.post(`/api/pages/${page.id}/threads`, {
      artboard: "a.html",
      selector: "ui-modal#confirm >>> div > footer > button:nth-of-type(2)",
      xPct: 10,
      yPct: 10,
      elementName: "bouton « OK »",
      body: "Make the OK button bigger",
    })
  ).json()) as Thread;

  const tab = await browser.newPage({ viewport: { width: 1400, height: 900 } });
  await tab.goto(`${server.url}/#/pages/${page.id}`);
  await tab.getByRole("tab", { name: /Commentaires/ }).click();
  const card = tab.locator(`[data-thread="${created.id}"]`);
  await card.waitFor();
  expect(await card.getByTestId("thread-instance").textContent()).toBe("dans ui-modal");
  expect(await card.getByTestId("thread-instance-gone").count()).toBe(0);

  await server.post(`/api/pages/${ds.pageId}/versions`, { files: { "manifest.json": MODAL_MANIFEST, "components/modal.html": MODAL_WITHOUT_FOOTER }, message: "Drop footer", origin: "thread" });
  await server.post(`/api/design-systems/${ds.id}/diffusions`, {});
  await tab.reload();
  await tab.getByRole("tab", { name: /Commentaires/ }).click();
  await card.waitFor();
  await card.getByTestId("thread-instance-gone").waitFor();
  expect(await card.getByTestId("thread-instance-gone").textContent()).toBe("l'élément commenté n'existe plus dans ui-modal");
}, 90_000);
