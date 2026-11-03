import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { build } from "vite";
import { type Browser } from "playwright";
import { launchBrowser } from "./journeyBrowser.js";
import { afterAll, beforeAll, expect, it } from "vitest";
import { CORE_TOKENS, type DesignSystem, type Page, type Thread } from "@redline/shared";
import { startTestServer, type TestServer } from "@redline/server/test-harness";

const webRoot = fileURLToPath(new URL("..", import.meta.url));

let server: TestServer;
let browser: Browser;
let webDir: string;

beforeAll(async () => {
  webDir = mkdtempSync(join(tmpdir(), "redline-web-"));
  await build({ root: webRoot, logLevel: "silent", build: { outDir: webDir, emptyOutDir: true } });
  server = await startTestServer({ webDir });
  browser = await launchBrowser();
}, 60_000);

afterAll(async () => {
  await browser?.close();
  await server?.stop();
  rmSync(webDir, { recursive: true, force: true });
});

const tokensCss = `:root {\n${CORE_TOKENS.map((t) => `  ${t}: #000;`).join("\n")}\n}\n`;
const modalFile = (template: string) =>
  `<!doctype html><html><head><style data-component>ui-modal{display:block;position:fixed;left:40px;top:80px;width:300px;background:#fff;border:1px solid #ccc}ui-modal:not([open]){display:none}</style></head><body><template data-component>${template}</template></body></html>`;
const MODAL = modalFile(`<div style="padding:16px"><slot></slot><footer><button class="close" closes="confirm">Close</button><button class="ok">OK</button></footer></div>`);
const MODAL_MANIFEST = JSON.stringify({ artboards: [{ file: "components/modal.html", x: 0, y: 0, width: 200, height: 100 }] });

async function setUp() {
  const ds = (await (await server.post("/api/design-systems", { title: "Acme DS", files: { "tokens.css": tokensCss, "manifest.json": MODAL_MANIFEST, "components/modal.html": MODAL } })).json()) as DesignSystem;
  const project = (await (await server.post("/api/projects", { title: "Acme" })).json()) as { id: string };
  const page = (await (
    await server.post(`/api/projects/${project.id}/pages`, {
      title: "Planning",
      files: {
        "manifest.json": JSON.stringify({ designSystem: ds.id, artboards: [{ file: "a.html", title: "Planning", x: 0, y: 0, width: 600, height: 500 }] }),
        "a.html": `<!doctype html><body style="margin:0;font-family:sans-serif"><h1>Planning</h1><button id="show" opens="confirm">Delete</button><ui-modal id="confirm"><p>Really?</p></ui-modal></body>`,
      },
    })
  ).json()) as Page;
  return { ds, page };
}

it("remembers the open modal a comment was written in, then opens it again and shows the pin when the thread is clicked", async () => {
  const { page } = await setUp();
  const tab = await browser.newPage({ viewport: { width: 1440, height: 900 } });
  await tab.goto(`${server.url}/#/pages/${page.id}`);
  const artboard = tab.frameLocator("iframe");
  await artboard.locator("h1").waitFor();

  await artboard.locator("#show").click();
  await artboard.locator("ui-modal[open] .ok").waitFor();
  await tab.getByRole("button", { name: "Commenter (C)" }).click();
  await artboard.locator(".ok").click();
  await tab.locator("#new-comment").fill("Make OK bigger");
  await tab.getByRole("button", { name: "Envoyer" }).click();

  const card = tab.locator("[data-thread]").first();
  await card.waitFor();
  expect(await card.getByTestId("thread-instance").textContent()).toBe("dans ui-modal");
  expect(await card.getByTestId("thread-instance-state").textContent()).toBe("vu avec confirm ouverte");
  await tab.locator("[data-pin]").waitFor();

  const [thread] = (await (await server.get(`/api/pages/${page.id}/threads`)).json()) as Thread[];
  expect(thread!.instanceState).toEqual([{ selector: "ui-modal#confirm", attributes: { open: "" } }]);

  // Closing the modal hides the pin; clicking the card opens the modal again and shows it.
  await tab.getByRole("button", { name: "Interagir (P)" }).click();
  await artboard.locator(".close").click();
  await expect.poll(() => tab.locator("[data-pin]").count()).toBe(0);
  await card.locator("p, div").first().click({ position: { x: 4, y: 4 } });
  await artboard.locator("ui-modal[open]").waitFor();
  await tab.locator("[data-pin]").waitFor();

  // After a reload the modal is closed and the pin waits for the replay.
  await tab.reload();
  await tab.getByRole("tab", { name: /Commentaires/ }).click();
  await tab.locator("[data-thread]").first().waitFor();
  expect(await tab.locator("[data-pin]").count()).toBe(0);
  expect(await tab.getByTestId("thread-state-gone").count()).toBe(0);
  await tab.close();
}, 90_000);

it("replays what still exists, shows the pin on the instance and says the state is no longer available", async () => {
  const { page } = await setUp();
  await server.post(`/api/pages/${page.id}/threads`, {
    artboard: "a.html",
    selector: "ui-modal#confirm >>> div > footer > button:nth-of-type(2)",
    xPct: 10,
    yPct: 10,
    body: "Make OK bigger",
    instanceState: [
      { selector: "ui-modal#confirm", attributes: { open: "" } },
      { selector: "ui-modal#gone", attributes: { open: "" } },
    ],
  });
  const tab = await browser.newPage({ viewport: { width: 1440, height: 900 } });
  await tab.goto(`${server.url}/#/pages/${page.id}`);
  await tab.getByRole("tab", { name: /Commentaires/ }).click();
  const card = tab.locator("[data-thread]").first();
  await card.getByTestId("thread-state-gone").waitFor();
  expect(await card.getByTestId("thread-state-gone").textContent()).toBe("état gone ouverte plus disponible");
  expect(await card.getByTestId("thread-instance-state").textContent()).toBe("vu avec confirm ouverte, gone ouverte");
  expect(await tab.locator("[data-pin]").count()).toBe(0);

  await card.locator("[class*=head]").first().click({ position: { x: 4, y: 4 } });
  await tab.frameLocator("iframe").locator("ui-modal[open]").waitFor();
  await tab.locator("[data-pin]").waitFor();
  await tab.close();
}, 90_000);
