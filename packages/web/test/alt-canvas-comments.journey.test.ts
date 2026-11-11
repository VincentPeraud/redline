import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { copyBuiltWeb } from "./builtWeb.js";
import { type Browser } from "playwright";
import { launchBrowser } from "./journeyBrowser.js";
import { afterAll, beforeAll, expect, it } from "vitest";
import type { Page, Thread } from "@redline/shared";
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

const manifest = JSON.stringify({
  artboards: [{ file: "home.html", title: "Accueil", width: 400, height: 300, x: 0, y: 200 }],
  elements: [
    { id: "note-parcours", kind: "sticky", text: "Parcours : accueil, paiement", width: 220, color: "yellow", x: 500, y: 200 },
    { kind: "sticky", text: "Ancienne note sans id", width: 220, color: "pink", x: 500, y: 450 },
    { id: "carte-site", kind: "link", url: "https://example.com/menu", title: "Menu", x: 0, y: 600 },
  ],
});

it("outlines and comments canvas elements with Alt in interactive mode, leaving plain clicks and id-less elements alone", async () => {
  const project = (await (await server.post("/api/projects", { title: "Alt canvas" })).json()) as { id: string };
  const page = (await (
    await server.post(`/api/projects/${project.id}/pages`, {
      title: "Parcours",
      files: { "home.html": "<!doctype html><body>Home</body>", "manifest.json": manifest },
    })
  ).json()) as Page;

  const tab = await browser.newPage({ viewport: { width: 1440, height: 900 } });
  const opened: string[] = [];
  await tab.context().route("https://example.com/**", (route) => {
    opened.push(route.request().url());
    return route.fulfill({ body: "<html></html>", contentType: "text/html" });
  });
  await tab.goto(`${server.url}/#/pages/${page.id}`);
  await tab.locator("[data-canvas-sticky]").first().waitFor();
  const outline = tab.getByTestId("canvas-hover-outline");
  const label = tab.getByTestId("canvas-hover-label");
  const note = tab.locator("[data-canvas-sticky][data-canvas-element-id=note-parcours]");

  await note.hover();
  expect(await outline.count()).toBe(0);

  await tab.keyboard.down("Alt");
  await tab.mouse.move(1200, 120);
  await note.hover();
  await label.waitFor();
  expect(await label.textContent()).toBe("Post-it · note-parcours");
  await tab.locator("[data-canvas-sticky]", { hasText: "sans id" }).hover();
  await expect.poll(() => outline.count()).toBe(0);

  await note.click();
  await tab.getByText("Commentaire sur").waitFor();
  expect(await tab.getByText("Commentaire sur").textContent()).toContain("Post-it · note-parcours");
  await tab.keyboard.up("Alt");
  await tab.mouse.move(1200, 120);
  await expect.poll(() => outline.count()).toBe(0);

  const link = tab.locator("[data-canvas-link]");
  await link.click({ modifiers: ["Alt"] });
  await expect.poll(async () => await tab.getByText("Commentaire sur").textContent()).toContain("Lien · carte-site");
  await tab.waitForTimeout(300);
  expect(opened).toEqual([]);

  const popup = tab.context().waitForEvent("page");
  await link.click();
  await (await popup).waitForLoadState();
  expect(opened).toEqual(["https://example.com/menu"]);
}, 90_000);
