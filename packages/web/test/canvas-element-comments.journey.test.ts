import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { build } from "vite";
import { chromium, type Browser } from "playwright";
import { afterAll, beforeAll, expect, it } from "vitest";
import type { Page, Thread } from "@redline/shared";
import { startTestServer, type TestServer } from "@redline/server/test-harness";

const webRoot = fileURLToPath(new URL("..", import.meta.url));

let server: TestServer;
let browser: Browser;
let webDir: string;

beforeAll(async () => {
  webDir = mkdtempSync(join(tmpdir(), "redline-web-"));
  await build({ root: webRoot, logLevel: "silent", build: { outDir: webDir, emptyOutDir: true } });
  server = await startTestServer({ webDir });
  browser = await chromium.launch();
}, 60_000);

afterAll(async () => {
  await browser?.close();
  await server?.stop();
  rmSync(webDir, { recursive: true, force: true });
});

const manifest = (stickyX: number, withSticky = true) =>
  JSON.stringify({
    artboards: [{ file: "home.html", title: "Accueil", width: 400, height: 300, x: 0, y: 200 }],
    elements: [
      { id: "titre-parcours", kind: "title", text: "Parcours billet", width: 600, x: 0, y: 0 },
      ...(withSticky ? [{ id: "note-parcours", kind: "sticky", text: "Parcours : accueil, paiement", width: 220, color: "yellow", x: stickyX, y: 200 }] : []),
      { kind: "sticky", text: "Ancienne note sans id", width: 220, color: "pink", x: 500, y: 450 },
      { id: "fleche-vers-paiement", kind: "arrow", from: "home.html", to: { x: 1000, y: 700 }, label: "mène au paiement" },
      { id: "carte-site", kind: "link", url: "https://example.com/menu", title: "Menu", x: 0, y: 600 },
    ],
  });

it("outlines canvas elements in comment mode, pins threads on them, follows their moves and ignores id-less ones", async () => {
  const project = (await (await server.post("/api/projects", { title: "Canvas comments" })).json()) as { id: string };
  const page = (await (
    await server.post(`/api/projects/${project.id}/pages`, {
      title: "Parcours billet",
      files: { "home.html": "<!doctype html><body>Home</body>", "manifest.json": manifest(500) },
    })
  ).json()) as Page;

  const tab = await browser.newPage({ viewport: { width: 1440, height: 900 } });
  await tab.goto(`${server.url}/#/pages/${page.id}`);
  await tab.locator("[data-canvas-sticky]").first().waitFor();
  const outline = tab.getByTestId("canvas-hover-outline");
  const label = tab.getByTestId("canvas-hover-label");
  const note = tab.locator("[data-canvas-sticky][data-canvas-element-id=note-parcours]");

  // Interactive mode: nothing is outlined.
  await note.hover();
  expect(await outline.count()).toBe(0);

  await tab.keyboard.press("c");
  await tab.mouse.move(1200, 120);
  await note.hover();
  await label.waitFor();
  expect(await label.textContent()).toBe("Post-it · note-parcours");
  const noteBox = (await note.boundingBox())!;
  const outlineBox = (await outline.boundingBox())!;
  expect(Math.abs(outlineBox.x - noteBox.x)).toBeLessThan(2);
  expect(Math.abs(outlineBox.width - noteBox.width)).toBeLessThan(2);

  await tab.locator("[data-canvas-title]").hover();
  await expect.poll(() => label.textContent()).toBe("Titre · titre-parcours");
  await tab.locator("[data-canvas-link]").hover();
  await expect.poll(() => label.textContent()).toBe("Lien · carte-site");

  // An element without id gets no outline.
  await tab.locator("[data-canvas-sticky]", { hasText: "sans id" }).hover();
  await expect.poll(() => outline.count()).toBe(0);

  // The arrow is aimed at on its line.
  const arrowPath = (await tab.locator("[data-canvas-arrow-hit]").boundingBox())!;
  const arrowMiddle = await tab.locator("[data-canvas-arrow-hit]").evaluate((el) => {
    const path = el as unknown as SVGPathElement;
    const point = path.getPointAtLength(path.getTotalLength() / 2);
    const m = path.getScreenCTM()!;
    return { x: point.x * m.a + m.e, y: point.y * m.d + m.f };
  });
  expect(arrowPath.width).toBeGreaterThan(0);
  await tab.mouse.move(arrowMiddle.x, arrowMiddle.y);
  await expect.poll(() => label.textContent()).toBe("Flèche · fleche-vers-paiement");
  await tab.mouse.move(1200, 120);
  await expect.poll(() => outline.count()).toBe(0);

  // A click on the sticky note pins a comment; the pin sits on its top-right corner.
  await note.click();
  await tab.getByText("Commentaire sur").waitFor();
  expect(await tab.getByText("Commentaire sur").textContent()).toContain("Post-it · note-parcours");
  await tab.getByRole("textbox").fill("Add the confirmation step");
  await tab.getByRole("button", { name: "Plus tard" }).click();
  const pin = tab.locator("[data-canvas-pin='1']");
  await pin.waitFor();
  const pinBox = (await pin.boundingBox())!;
  expect(Math.abs(pinBox.x + pinBox.width / 2 - (noteBox.x + noteBox.width))).toBeLessThan(6);
  expect(Math.abs(pinBox.y + pinBox.height / 2 - noteBox.y)).toBeLessThan(6);
  await expect.poll(() => tab.getByTestId("held-thread").textContent()).toContain("Post-it · note-parcours");

  // A click on an element without id pins nothing.
  await tab.locator("[data-canvas-sticky]", { hasText: "sans id" }).click();
  expect(await tab.getByText("Commentaire sur").count()).toBe(0);

  // A click on a link card pins a comment instead of following the link.
  const popups: unknown[] = [];
  tab.context().on("page", (p) => popups.push(p));
  await tab.locator("[data-canvas-link]").click();
  await tab.getByText("Commentaire sur").waitFor();
  expect(await tab.getByText("Commentaire sur").textContent()).toContain("Lien · carte-site");
  expect(popups).toHaveLength(0);
  await tab.getByRole("textbox").fill("Is this the right menu?");
  await tab.getByRole("button", { name: "Envoyer", exact: true }).click();
  await expect.poll(() => tab.locator("[data-canvas-pin='2']").count()).toBe(1);

  // The thread is labelled "<Kind> · <id>" and supports the thread flow (Résoudre).
  const threads = (await (await server.get(`/api/pages/${page.id}/threads`)).json()) as Thread[];
  expect(threads.map((t) => t.target)).toMatchObject([
    { kind: "canvas-element", elementId: "note-parcours", elementKind: "sticky" },
    { kind: "canvas-element", elementId: "carte-site", elementKind: "link" },
  ]);
  await tab.getByRole("tab", { name: /^Commentaires/ }).click();
  await tab.getByRole("button", { name: "Résoudre" }).first().waitFor();

  // The pin follows the element when Claude moves it.
  await server.post(`/api/pages/${page.id}/versions`, {
    files: { "manifest.json": manifest(700) },
    message: "Move the note",
    origin: "thread",
  });
  await expect.poll(async () => (await note.boundingBox())!.x).toBeGreaterThan(noteBox.x + 100);
  const movedNote = (await note.boundingBox())!;
  await expect
    .poll(async () => {
      const box = (await pin.boundingBox())!;
      return Math.abs(box.x + box.width / 2 - (movedNote.x + movedNote.width));
    })
    .toBeLessThan(6);
}, 90_000);

it("keeps the thread of a removed canvas element in the list, greyed and unpinned, and restores it when the id returns", async () => {
  const project = (await (await server.post("/api/projects", { title: "Removed elements" })).json()) as { id: string };
  const page = (await (
    await server.post(`/api/projects/${project.id}/pages`, {
      title: "Parcours",
      files: { "home.html": "<!doctype html><body>Home</body>", "manifest.json": manifest(500) },
    })
  ).json()) as Page;
  await server.post(`/api/pages/${page.id}/threads`, { target: { kind: "canvas-element", elementId: "note-parcours" }, body: "Add the confirmation step" });

  const tab = await browser.newPage({ viewport: { width: 1440, height: 900 } });
  await tab.goto(`${server.url}/#/pages/${page.id}`);
  await tab.locator("[data-canvas-pin='1']").waitFor();
  await tab.getByRole("tab", { name: /^Commentaires/ }).click();
  expect(await tab.getByTestId("removed-tag").count()).toBe(0);

  const publish = (withSticky: boolean) =>
    server.post(`/api/pages/${page.id}/versions`, { files: { "manifest.json": manifest(500, withSticky) }, message: "Edit the note", origin: "thread" });

  await publish(false);
  await tab.getByTestId("removed-tag").waitFor();
  expect(await tab.getByTestId("removed-tag").textContent()).toBe("retiré du canvas");
  expect(await tab.locator("[data-canvas-pin='1']").count()).toBe(0);
  await tab.getByRole("button", { name: "Répondre" }).click();
  await tab.getByRole("button", { name: "Répondre" }).waitFor();

  await publish(true);
  await tab.locator("[data-canvas-pin='1']").waitFor();
  expect(await tab.getByTestId("removed-tag").count()).toBe(0);

  await publish(false);
  await tab.getByTestId("removed-tag").waitFor();
  await tab.getByRole("button", { name: "Résoudre" }).click();
  await tab.getByText("Résolu", { exact: true }).waitFor();
}, 90_000);
