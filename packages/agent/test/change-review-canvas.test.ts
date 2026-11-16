import { afterEach, describe, expect, it } from "vitest";
import type { ChangeReview, Page, PageChangeReview, Thread } from "@redline/shared";
import { FakeEngine, startSeam2, type Seam2 } from "./support/seam2.js";
import { openTerminal, type Terminal } from "./support/terminal.js";

const manifest = (elements: unknown[]) =>
  JSON.stringify({
    artboards: [{ file: "instance.html", title: "Instance", x: 0, y: 100, width: 800, height: 600 }],
    elements,
  });
const TITLE = { id: "t-settings", kind: "title", text: "Settings", width: 600, x: 0, y: -200 };
const NOTE = { id: "note-archives", kind: "sticky", text: "Archives are on the other page", width: 240, size: "m", color: "yellow", x: 900, y: 120 };
const ARROW = { id: "fleche-membres", kind: "arrow", from: "instance.html", to: "note-archives", color: "gray" };
const FOOTER = { id: "note-bas", kind: "sticky", text: "Below", width: 240, size: "m", color: "pink", x: 0, y: 900 };
const FILES = (elements: unknown[] = [TITLE, NOTE, ARROW, FOOTER]) => ({ "instance.html": "<!doctype html><h1>Instance</h1>", "manifest.json": manifest(elements) });

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
const canvasStep = (page: Page, canvasElements: string[], extra: Record<string, unknown> = {}) => ({ pageId: page.id, canvasElements, changed: "Moved the archives note", lookAt: "The note", question: "Is the note enough?", ...extra });

async function start(): Promise<{ terminal: Terminal; page: Page }> {
  seam = await startSeam2(new FakeEngine(() => []));
  const page = await seam.createPage(FILES(), "Settings");
  return { terminal: await openTerminal(seam, stops, "MacBook-Pro"), page };
}

describe("request_review with canvasElements", () => {
  it("accepts a step that points at canvas elements only, with no artboard, and shows the page canvas at their current places", async () => {
    const { terminal, page } = await start();

    const answer = await terminal.call("request_review", { steps: [canvasStep(page, ["note-archives"])] });

    const step = (await reviewOf(idOf(answer))).steps[0]!;
    expect(step).toMatchObject({ pageId: page.id, artboard: "", canvasElements: ["note-archives"], pageTitle: "Settings", answers: [], pins: [] });
    expect(step.canvas).toMatchObject({ missing: [], artboards: [{ file: "instance.html", x: 0, y: 100 }] });
    expect(step.canvas!.elements.map((element) => element.id)).toEqual(["t-settings", "note-archives", "fleche-membres", "note-bas"]);
  });

  it("accepts canvas elements next to an artboard (a mixed step)", async () => {
    const { terminal, page } = await start();

    const answer = await terminal.call("request_review", { steps: [canvasStep(page, ["note-archives"], { artboard: "instance.html" })] });

    expect((await reviewOf(idOf(answer))).steps[0]).toMatchObject({ artboard: "instance.html", canvasElements: ["note-archives"], artboardTitle: "Instance" });
  });

  it("refuses an unknown element id naming the step and listing the page's elements, and creates no review", async () => {
    const { terminal, page } = await start();

    const answer = await terminal.call("request_review", { steps: [canvasStep(page, ["note-archive"], { title: "Settings · archives note" })] });

    expect(answer).toContain("Unknown canvas elements");
    expect(answer).toContain(`Step "Settings · archives note"`);
    expect(answer).toContain(`"note-archive" does not exist on page Settings`);
    expect(answer).toContain("Elements of the page: t-settings, note-archives, fleche-membres, note-bas");
    expect(answer).not.toMatch(/#\/reviews\//);
    expect(await bannersOf(page.id)).toEqual([]);
  });

  it("refuses a step with neither an artboard nor canvas elements", async () => {
    const { terminal, page } = await start();

    const answer = await terminal.call("request_review", { steps: [{ pageId: page.id, changed: "x", lookAt: "y", question: "z" }] });

    expect(answer).not.toMatch(/#\/reviews\//);
    expect(answer).toMatch(/artboard|canvasElements/);
  });

  it("keeps a canvas step apart from the artboard step and places it by the reading order of its first element", async () => {
    const { terminal, page } = await start();
    const artboardStep = { pageId: page.id, artboard: "instance.html", changed: "c", lookAt: "l", question: "q" };

    const answer = await terminal.call("request_review", { steps: [canvasStep(page, ["note-bas"]), artboardStep, canvasStep(page, ["t-settings"]), canvasStep(page, ["note-archives"])] });

    const review = await reviewOf(idOf(answer));
    expect(review.steps.map((step) => step.canvasElements?.[0] ?? step.artboard)).toEqual(["t-settings", "instance.html", "note-archives", "note-bas"]);
  });

  it("merges a redeclared canvas step into the open review, keeping its answers", async () => {
    const { terminal, page } = await start();
    const first = idOf(await terminal.call("request_review", { steps: [canvasStep(page, ["note-archives"])] }));
    const { id } = (await reviewOf(first)).steps[0]!;
    await send("PUT", `/api/change-reviews/${first}/steps/${id}/ok`);

    await terminal.call("request_review", { steps: [canvasStep(page, ["note-archives"], { question: "Still enough?" })] });

    expect((await reviewOf(first)).steps).toMatchObject([{ id, question: "Still enough?" }]);
  });

  it("shows the element where it is now, and lists the ones that are gone", async () => {
    const { terminal, page } = await start();
    const reviewId = idOf(await terminal.call("request_review", { steps: [canvasStep(page, ["note-archives"])] }));

    await send("POST", `/api/pages/${page.id}/versions`, { files: FILES([{ ...NOTE, x: 1500 }]), message: "Move the note", origin: "user" });
    expect((await reviewOf(reviewId)).steps[0]!.canvas!.elements).toMatchObject([{ id: "note-archives", x: 1500 }]);

    await send("POST", `/api/pages/${page.id}/versions`, { files: FILES([]), message: "Delete the note", origin: "user" });
    const step = (await reviewOf(reviewId)).steps[0]!;
    expect(step.canvas!.missing).toEqual(["note-archives"]);
    expect(step.removed).toBeUndefined();
  });
});

describe("pins and zones on a canvas step", () => {
  const pinOn = (reviewId: string, stepId: string, target: unknown, text = "Make it a button") => send("POST", `/api/change-reviews/${reviewId}/steps/${stepId}/pins`, { text, target });
  async function declared() {
    const { terminal, page } = await start();
    const reviewId = idOf(await terminal.call("request_review", { steps: [canvasStep(page, ["note-archives"])] }));
    return { terminal, page, reviewId, stepId: (await reviewOf(reviewId)).steps[0]!.id };
  }

  it("accepts a pin on one of the step's canvas elements and a zone in canvas pixels", async () => {
    const { reviewId, stepId } = await declared();

    expect((await pinOn(reviewId, stepId, { kind: "canvas-element", elementId: "note-archives", elementKind: "sticky" })).status).toBe(200);
    expect((await pinOn(reviewId, stepId, { kind: "zone", space: "canvas", x: 880, y: 300, w: 268, h: 70 }, "Add an arrow")).status).toBe(200);

    expect((await reviewOf(reviewId)).steps[0]!.pins).toMatchObject([
      { number: 1, target: { kind: "canvas-element", elementId: "note-archives", elementKind: "sticky", elementSummary: "« Archives are on the other page »" } },
      { number: 2, target: { kind: "zone", space: "canvas", x: 880, y: 300, w: 268, h: 70 } },
    ]);
  });

  it("refuses a pin on a canvas element the step does not point at, and a malformed canvas zone", async () => {
    const { reviewId, stepId } = await declared();

    expect((await pinOn(reviewId, stepId, { kind: "canvas-element", elementId: "note-bas", elementKind: "sticky" })).status).toBe(400);
    expect((await pinOn(reviewId, stepId, { kind: "canvas-element", elementId: "nope", elementKind: "sticky" })).status).toBe(400);
    expect((await pinOn(reviewId, stepId, { kind: "zone", space: "canvas", x: 0, y: 0, w: 0, h: 10 })).status).toBe(400);
    expect((await pinOn(reviewId, stepId, { kind: "zone", space: "canvas", x: "0", y: 0, w: 10, h: 10 })).status).toBe(400);
    expect((await pinOn(reviewId, stepId, { kind: "zone", space: "artboard", xPct: 1, yPct: 1, wPct: 10, hPct: 10 })).status).toBe(400);
  });

  it("opens canvas-element threads for pins and the general remark, and a zone thread, and says so in the feedback", async () => {
    const { terminal, page, reviewId, stepId } = await declared();
    await pinOn(reviewId, stepId, { kind: "canvas-element", elementId: "note-archives", elementKind: "sticky" });
    await pinOn(reviewId, stepId, { kind: "zone", space: "canvas", x: 880, y: 300, w: 268.5, h: 70 }, "Add an arrow");
    await send("PUT", `/api/change-reviews/${reviewId}/steps/${stepId}/remark`, { text: "General" });
    await send("POST", `/api/change-reviews/${reviewId}/finish`);

    const answer = await terminal.call("review_feedback", { reviewId });

    const threads = await threadsOf(page.id);
    expect(threads.find((thread) => thread.body === "Make it a button")).toMatchObject({ target: { kind: "canvas-element", elementId: "note-archives", elementKind: "sticky" } });
    expect(threads.find((thread) => thread.body === "General")).toMatchObject({ target: { kind: "canvas-element", elementId: "note-archives" } });
    expect(threads.find((thread) => thread.body === "Add an arrow")).toMatchObject({ target: { kind: "zone", space: "canvas", x: 880, y: 300, w: 268.5, h: 70 } });
    expect(answer).toMatch(/1\. pin on canvas element `note-archives` \(sticky\)[^\n]*thread [0-9a-f-]+/);
    expect(answer).toMatch(/2\. zone x 880 px · y 300 px · 268\.5 px × 70 px du canevas/);
    expect(answer).toMatch(/general remark/);
  });

  it("opens a thread marked removed for a pin on an element deleted before the fetch", async () => {
    const { terminal, page, reviewId, stepId } = await declared();
    await pinOn(reviewId, stepId, { kind: "canvas-element", elementId: "note-archives", elementKind: "sticky" });
    await send("POST", `/api/pages/${page.id}/versions`, { files: FILES([]), message: "Delete the note", origin: "user" });
    await send("POST", `/api/change-reviews/${reviewId}/finish`);

    await terminal.call("review_feedback", { reviewId });

    expect((await threadsOf(page.id))[0]).toMatchObject({ body: "Make it a button", removed: true, target: { kind: "canvas-element", elementId: "note-archives", elementKind: "sticky" } });
  });
});
