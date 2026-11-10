import { afterEach, describe, expect, it } from "vitest";
import type { Thread } from "@redline/shared";
import { FakeEngine, startSeam2, type Seam2 } from "./support/seam2.js";

const PAGE_FILES = {
  "home.html": "<!doctype html><h1>Old title</h1><button>Go</button>",
  "manifest.json": JSON.stringify({
    artboards: [{ file: "home.html" }],
    elements: [
      { id: "titre-parcours", kind: "title", text: "Parcours billet", width: 600, x: 0, y: 0 },
      { id: "note-parcours", kind: "sticky", text: "Parcours : accueil -> paiement", width: 240, size: "m", color: "yellow", x: 0, y: 100 },
      { id: "fleche-vers-paiement", kind: "arrow", from: "home.html", to: { x: 900, y: 300 }, color: "gray", label: "mène au paiement" },
      { id: "carte-site", kind: "link", url: "https://example.com/menu", title: "Menu", x: 0, y: 400 },
      { id: "capture-accueil", kind: "image", src: "assets/accueil.png", width: 300, x: 0, y: 500 },
    ],
  }),
};

let seam: Seam2 | undefined;
afterEach(async () => {
  await seam?.stop();
  seam = undefined;
});

const canvasElement = (seam: Seam2, pageId: string, elementId: string, body: string, held = false) =>
  seam.server.post(`/api/pages/${pageId}/threads`, { target: { kind: "canvas-element", elementId }, body, held });

describe("comments on canvas elements", () => {
  it("reach the session with the element id, kind and content, and a hint to edit manifest.json", async () => {
    const engine = new FakeEngine(() => [{ type: "result" as const, summary: "Looked" }]);
    seam = await startSeam2(engine);
    const page = await seam.createPage(PAGE_FILES);
    const thread = (await (await canvasElement(seam, page.id, "note-parcours", "Add the confirmation step")).json()) as Thread;
    await seam.waitForWorkEnd(1);

    const { message } = engine.runs[0];
    expect(message).toContain(
      `Comment 1 (thread id: ${thread.id}) on the canvas element \`note-parcours\` (sticky, « Parcours : accueil -> paiement ») of manifest.json:`,
    );
    expect(message).toContain("Add the confirmation step");
    expect(message).toContain("manifest.json");
    expect(message).toContain("keep its id");
    expect(message).not.toContain("position");
  });

  it("summarises each kind by its text, label, link target or image file", async () => {
    const engine = new FakeEngine(() => [{ type: "result" as const, summary: "Looked" }]);
    seam = await startSeam2(engine);
    const page = await seam.createPage(PAGE_FILES);
    for (const id of ["titre-parcours", "fleche-vers-paiement", "carte-site", "capture-accueil"]) {
      await canvasElement(seam, page.id, id, `About ${id}`, true);
    }
    await seam.server.post(`/api/pages/${page.id}/send-held`, {});
    await seam.waitForWorkEnd(1);

    const { message } = engine.runs[0];
    expect(message).toContain("`titre-parcours` (title, « Parcours billet »)");
    expect(message).toContain("`fleche-vers-paiement` (arrow, « mène au paiement »)");
    expect(message).toContain("`carte-site` (link, https://example.com/menu)");
    expect(message).toContain("`capture-accueil` (image, assets/accueil.png)");
  });

  it("are described in a batch mixing the three target kinds, each with its own tail", async () => {
    const engine = new FakeEngine(() => [{ type: "result" as const, summary: "Looked" }]);
    seam = await startSeam2(engine);
    const page = await seam.createPage(PAGE_FILES);
    const element = await seam.pinThread(page.id, "home.html", "Bigger title", { held: true });
    const canvas = (await (await canvasElement(seam, page.id, "note-parcours", "Fix the note", true)).json()) as Thread;
    await seam.server.post(`/api/pages/${page.id}/send-held`, {});
    await seam.waitForWorkEnd(1);

    const { message } = engine.runs[0];
    expect(message).toContain("2 comments on this page");
    expect(message).toContain(`Comment ${element.number} (thread id: ${element.id}) on artboard home.html, element \`h1\``);
    expect(message).toContain(`Comment ${canvas.number} (thread id: ${canvas.id}) on the canvas element \`note-parcours\` (sticky,`);
    expect(message).toContain("keep its id");
  });

  it("describe the element as it is now when the message is built, not as it was at comment time", async () => {
    const engine = new FakeEngine(() => [{ type: "result" as const, summary: "Looked" }]);
    seam = await startSeam2(engine);
    const page = await seam.createPage(PAGE_FILES);
    await canvasElement(seam, page.id, "note-parcours", "Check the note", true);
    const manifest = JSON.parse(PAGE_FILES["manifest.json"]);
    manifest.elements[1].text = "Parcours : accueil -> panier -> paiement";
    await seam.server.post(`/api/pages/${page.id}/versions`, { files: { "manifest.json": JSON.stringify(manifest) }, message: "Edit", origin: "thread" });
    await seam.server.post(`/api/pages/${page.id}/send-held`, {});
    await seam.waitForWorkEnd(1);

    const { message } = engine.runs[0];
    expect(message).toContain("(sticky, « Parcours : accueil -> panier -> paiement »)");
    expect(message).not.toContain("« Parcours : accueil -> paiement »");
  });

  it("say so when the element is no longer on the canvas, keeping what it showed", async () => {
    const engine = new FakeEngine(() => [{ type: "result" as const, summary: "Looked" }]);
    seam = await startSeam2(engine);
    const page = await seam.createPage(PAGE_FILES);
    await canvasElement(seam, page.id, "note-parcours", "Check the note", true);
    const manifest = JSON.parse(PAGE_FILES["manifest.json"]);
    manifest.elements = manifest.elements.filter((e: { id: string }) => e.id !== "note-parcours");
    await seam.server.post(`/api/pages/${page.id}/versions`, { files: { "manifest.json": JSON.stringify(manifest) }, message: "Edit", origin: "thread" });
    const held = (await (await seam.server.get(`/api/pages/${page.id}/held`)).json()) as Thread[];
    expect(held[0].removed).toBe(true);
    await seam.server.post(`/api/pages/${page.id}/send-held`, {});
    await seam.waitForWorkEnd(1);

    expect(engine.runs[0].message).toContain("`note-parcours` (sticky, « Parcours : accueil -> paiement ») of manifest.json (no longer on the canvas)");
  });

  it("are documented in the session guide, without the old rule that elements take no comments", async () => {
    const { REDLINE_GUIDE } = await import("../src/guide.js");
    expect(REDLINE_GUIDE).toContain("canvas element");
    expect(REDLINE_GUIDE).not.toContain("take no comments");
    expect(REDLINE_GUIDE).toContain("3: the canvas element `<id>` (<kind>, <content>)");
  });
});
