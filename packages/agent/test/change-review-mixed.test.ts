import { afterEach, describe, expect, it } from "vitest";
import type { ChangeReview, Page, PageChangeReview, Thread } from "@redline/shared";
import { FakeEngine, startSeam2, type Seam2 } from "./support/seam2.js";
import { openTerminal, type Terminal } from "./support/terminal.js";

const manifest = (artboards: string[], elements: unknown[]) =>
  JSON.stringify({ artboards: artboards.map((file, index) => ({ file, title: file, x: index * 900, y: 100, width: 800, height: 600 })), elements });
const NOTE = { id: "note-archives", kind: "sticky", text: "Archives are on the other page", width: 240, size: "m", color: "yellow", x: 2000, y: 120 };
const files = (artboards: string[], elements: unknown[]) => ({ ...Object.fromEntries(artboards.map((file) => [file, `<!doctype html><h1>${file}</h1>`])), "manifest.json": manifest(artboards, elements) });

let seam: Seam2 | undefined;
const stops: (() => Promise<void>)[] = [];
afterEach(async () => {
  for (const stop of stops.splice(0)) await stop();
  await seam?.stop();
  seam = undefined;
});

const idOf = (answer: string) => /#\/reviews\/([0-9a-f-]{36})/.exec(answer)![1]!;
const send = (method: string, path: string, body?: unknown) =>
  fetch(`${seam!.server.url}${path}`, { method, ...(body === undefined ? {} : { headers: { "content-type": "application/json" }, body: JSON.stringify(body) }) });
const reviewOf = async (id: string) => (await (await seam!.server.get(`/api/change-reviews/${id}`)).json()) as ChangeReview;
const bannersOf = async (pageId: string) => (await (await seam!.server.get(`/api/pages/${pageId}/change-reviews`)).json()) as PageChangeReview[];
const threadsOf = async (pageId: string) => (await (await seam!.server.get(`/api/pages/${pageId}/threads`)).json()) as Thread[];
const publish = (page: Page, artboards: string[], elements: unknown[]) =>
  send("POST", `/api/pages/${page.id}/versions`, { files: files(artboards, elements), message: "Edit", origin: "user", confirmRemovals: true });
const mixed = (page: Page, artboard: string) => ({ pageId: page.id, artboard, canvasElements: ["note-archives"], changed: "Link and note", lookAt: "Both", question: "Fine?" });

async function start(): Promise<{ terminal: Terminal; page: Page; reviewId: string; stepId: string }> {
  seam = await startSeam2(new FakeEngine(() => []));
  const page = await seam.createPage(files(["a.html", "b.html"], [NOTE]), "Settings");
  const terminal = await openTerminal(seam, stops, "MacBook-Pro");
  const reviewId = idOf(await terminal.call("request_review", { steps: [mixed(page, "b.html")] }));
  return { terminal, page, reviewId, stepId: (await reviewOf(reviewId)).steps[0]!.id };
}

describe("a mixed step", () => {
  it("is placed by its first artboard, among the artboard and canvas steps of its page", async () => {
    seam = await startSeam2(new FakeEngine(() => []));
    const page = await seam.createPage(files(["a.html", "b.html", "c.html"], [NOTE, { ...NOTE, id: "note-2", x: 10 }]), "Settings");
    const terminal = await openTerminal(seam, stops, "MacBook-Pro");
    const plain = (artboard: string) => ({ pageId: page.id, artboard, changed: "c", lookAt: "l", question: "q" });

    const answer = await terminal.call("request_review", { steps: [plain("c.html"), mixed(page, "b.html"), { pageId: page.id, canvasElements: ["note-2"], changed: "c", lookAt: "l", question: "q" }, plain("a.html")] });

    expect((await reviewOf(idOf(answer))).steps.map((step) => step.artboard || step.canvasElements![0]!)).toEqual(["a.html", "note-2", "b.html", "c.html"]);
  });

  it("takes a pin on its artboard and one on its note, and gives Claude a thread on each", async () => {
    const { terminal, page, reviewId, stepId } = await start();
    const pin = (target: unknown, text: string) => send("POST", `/api/change-reviews/${reviewId}/steps/${stepId}/pins`, { text, target });
    expect((await pin({ selector: "body > h1", xPct: 10, yPct: 10 }, "Link is faint")).status).toBe(200);
    expect((await pin({ kind: "canvas-element", elementId: "note-archives", elementKind: "sticky" }, "Name the page")).status).toBe(200);
    await send("POST", `/api/change-reviews/${reviewId}/finish`);

    await terminal.call("review_feedback", { reviewId });

    const threads = await threadsOf(page.id);
    expect(threads.find((thread) => thread.body === "Link is faint")).toMatchObject({ target: { kind: "element", artboard: "b.html" } });
    expect(threads.find((thread) => thread.body === "Name the page")).toMatchObject({ target: { kind: "canvas-element", elementId: "note-archives" } });
  });

  it("keeps its canvas view when its artboard is deleted, and its remark becomes a thread on the note", async () => {
    const { terminal, page, reviewId, stepId } = await start();
    await send("PUT", `/api/change-reviews/${reviewId}/steps/${stepId}/remark`, { text: "The note is off" });

    await publish(page, ["a.html"], [NOTE]);

    expect((await reviewOf(reviewId)).steps[0]!.removed).toBeUndefined();
    expect((await bannersOf(page.id))[0]).toMatchObject({ stepCount: 1 });
    await send("POST", `/api/change-reviews/${reviewId}/finish`);
    await terminal.call("review_feedback", { reviewId });
    expect(await threadsOf(page.id)).toMatchObject([{ body: "The note is off", target: { kind: "canvas-element", elementId: "note-archives" } }]);
  });

  it("is out of the review when its artboard and all its canvas elements are deleted", async () => {
    const { page, reviewId } = await start();

    await publish(page, ["a.html"], []);

    expect((await reviewOf(reviewId)).steps[0]!.removed).toBe("deleted");
  });

  it("behaves as an artboard step when all its canvas elements are deleted: its remark stays a thread on the artboard", async () => {
    const { terminal, page, reviewId, stepId } = await start();
    await send("PUT", `/api/change-reviews/${reviewId}/steps/${stepId}/remark`, { text: "Link is off" });

    await publish(page, ["a.html", "b.html"], []);

    const step = (await reviewOf(reviewId)).steps[0]!;
    expect(step.removed).toBeUndefined();
    expect(step.canvas!.missing).toEqual(["note-archives"]);
    await send("POST", `/api/change-reviews/${reviewId}/finish`);
    await terminal.call("review_feedback", { reviewId });
    expect(await threadsOf(page.id)).toMatchObject([{ body: "Link is off", target: { kind: "artboard", artboard: "b.html" } }]);
  });
});
