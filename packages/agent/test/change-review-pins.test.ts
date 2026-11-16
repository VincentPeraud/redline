import { afterEach, describe, expect, it } from "vitest";
import type { ChangeReview, Thread } from "@redline/shared";
import { FakeEngine, startSeam2, type Seam2 } from "./support/seam2.js";
import { openTerminal, type Terminal } from "./support/terminal.js";

const PAGE_FILES = {
  "list.html": "<!doctype html><h1>List</h1>",
  "empty.html": "<!doctype html><h1>Empty</h1>",
  "manifest.json": JSON.stringify({
    artboards: [
      { file: "list.html", title: "List", x: 0, y: 0, width: 1200, height: 800 },
      { file: "empty.html", title: "Empty", x: 1300, y: 0, width: 1200, height: 800 },
    ],
  }),
};

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
const threadsOf = async (pageId: string) => (await (await seam!.server.get(`/api/pages/${pageId}/threads`)).json()) as Thread[];

const TARGET = { selector: "body > h1", elementName: "titre « List »", xPct: 40, yPct: 12 };
const addPin = (reviewId: string, stepId: string, text: string, extra: Record<string, unknown> = {}) => send("POST", `/api/change-reviews/${reviewId}/steps/${stepId}/pins`, { text, target: TARGET, ...extra });

async function declared(): Promise<{ terminal: Terminal; reviewId: string; pageId: string; stepId: string }> {
  seam = await startSeam2(new FakeEngine(() => []));
  const home = await seam.createPage(PAGE_FILES, "Home");
  const terminal = await openTerminal(seam, stops, "MacBook-Pro");
  const step = (artboard: string) => ({ pageId: home.id, artboard, changed: `Changed ${artboard}`, lookAt: `Look at ${artboard}`, question: `Is ${artboard} fine?` });
  const reviewId = idOf(await terminal.call("request_review", { steps: [step("list.html"), step("empty.html")] }));
  return { terminal, reviewId, pageId: home.id, stepId: (await reviewOf(reviewId)).steps[0]!.id };
}

describe("pins through the routes", () => {
  it("numbers pins per step in creation order, lists them as the viewer's own, and refuses an empty text", async () => {
    const { reviewId, stepId } = await declared();

    expect((await addPin(reviewId, stepId, "First")).status).toBe(200);
    expect((await addPin(reviewId, stepId, "Second")).status).toBe(200);
    expect((await addPin(reviewId, stepId, "  ")).status).toBe(400);

    const step = (await reviewOf(reviewId)).steps[0]!;
    expect(step.pins).toMatchObject([
      { number: 1, text: "First", mine: true, target: TARGET },
      { number: 2, text: "Second", mine: true },
    ]);
    expect((await reviewOf(reviewId)).steps[1]!.pins).toEqual([]);
  });

  it("never reuses the number of a deleted pin", async () => {
    const { reviewId, stepId } = await declared();
    await addPin(reviewId, stepId, "First");
    await addPin(reviewId, stepId, "Second");
    const second = (await reviewOf(reviewId)).steps[0]!.pins[1]!;

    expect((await send("DELETE", `/api/change-reviews/${reviewId}/pins/${second.id}`)).status).toBe(200);
    await addPin(reviewId, stepId, "Third");

    expect((await reviewOf(reviewId)).steps[0]!.pins.map((pin) => pin.number)).toEqual([1, 3]);
  });

  it("edits a pin's text, and refuses to change or add pins once the review is finished", async () => {
    const { reviewId, stepId } = await declared();
    await addPin(reviewId, stepId, "First");
    const pin = (await reviewOf(reviewId)).steps[0]!.pins[0]!;

    expect((await send("PUT", `/api/change-reviews/${reviewId}/pins/${pin.id}`, { text: "Edited" })).status).toBe(200);
    expect((await send("PUT", `/api/change-reviews/${reviewId}/pins/${pin.id}`, { text: "" })).status).toBe(400);
    await send("POST", `/api/change-reviews/${reviewId}/finish`);

    expect((await send("PUT", `/api/change-reviews/${reviewId}/pins/${pin.id}`, { text: "Late" })).status).toBe(409);
    expect((await send("DELETE", `/api/change-reviews/${reviewId}/pins/${pin.id}`)).status).toBe(409);
    expect((await addPin(reviewId, stepId, "Late")).status).toBe(409);
    expect((await reviewOf(reviewId)).steps[0]!.pins).toMatchObject([{ text: "Edited" }]);
  });

  it("replaces the author's OK, and leaves no answer once all their feedback is deleted", async () => {
    const { reviewId, stepId } = await declared();
    await send("PUT", `/api/change-reviews/${reviewId}/steps/${stepId}/ok`);

    await addPin(reviewId, stepId, "First");

    expect((await reviewOf(reviewId)).steps[0]!.answers).toEqual([]);
    expect((await send("PUT", `/api/change-reviews/${reviewId}/steps/${stepId}/ok`)).status).toBe(409);
    await send("DELETE", `/api/change-reviews/${reviewId}/pins/${(await reviewOf(reviewId)).steps[0]!.pins[0]!.id}`);
    expect((await reviewOf(reviewId)).steps[0]).toMatchObject({ answers: [], pins: [] });
  });

  it("clears the member's pins and remark and records an OK in one call", async () => {
    const { reviewId, stepId } = await declared();
    await addPin(reviewId, stepId, "First");
    await send("PUT", `/api/change-reviews/${reviewId}/steps/${stepId}/remark`, { text: "General" });

    expect((await send("POST", `/api/change-reviews/${reviewId}/steps/${stepId}/clear-and-validate`)).status).toBe(200);

    expect((await reviewOf(reviewId)).steps[0]).toMatchObject({ pins: [], answers: [{ kind: "ok", mine: true }] });
  });

  it("refuses a pin on an artboard that is not one of the step's", async () => {
    const { reviewId, stepId, pageId } = await declared();

    expect((await addPin(reviewId, stepId, "Nope", { pageId, artboard: "empty.html" })).status).toBe(400);
  });
});

describe("pins at fetch", () => {
  it("opens one element thread per pin, groups the feedback under its step, and gives the same result again without new threads", async () => {
    const { terminal, reviewId, pageId, stepId } = await declared();
    await addPin(reviewId, stepId, "Make it bold\nand bigger", { rendering: undefined });
    await addPin(reviewId, stepId, "Second");
    await send("PUT", `/api/change-reviews/${reviewId}/steps/${stepId}/remark`, { text: "General remark" });
    await send("POST", `/api/change-reviews/${reviewId}/finish`);

    const answer = await terminal.call("review_feedback", { reviewId });

    const threads = await threadsOf(pageId);
    expect(threads).toHaveLength(3);
    expect(threads.find((thread) => thread.body === "Make it bold\nand bigger")).toMatchObject({ target: { kind: "element", artboard: "list.html", selector: "body > h1", elementName: "titre « List »", xPct: 40, yPct: 12 } });
    expect(answer).toMatch(/Feedback \(3 on 1 step\)/);
    expect(answer).toMatch(/"Home · List"\n\s+1\. pin on `body > h1` \("titre « List »"\)[^\n]*thread [0-9a-f-]+/);
    expect(answer).toContain("> Make it bold");
    expect(answer).toContain("> and bigger");
    expect(answer).toMatch(/general remark/);
    const first = threads.find((thread) => thread.body === "Second")!;
    expect(await terminal.call("reply_in_thread", { threadId: first.id, text: "Done" })).toContain("Reply posted");

    const again = await terminal.call("review_feedback", { reviewId });

    expect(again).toContain("Already fetched");
    expect(await threadsOf(pageId)).toHaveLength(3);
  });

  it("marks a pin whose element was reported lost, and keeps its last position", async () => {
    const { terminal, reviewId, pageId, stepId } = await declared();
    await addPin(reviewId, stepId, "Where did it go");
    const pin = (await reviewOf(reviewId)).steps[0]!.pins[0]!;
    await send("PUT", `/api/change-reviews/${reviewId}/pins/${pin.id}/lost`, { lost: true });
    await send("POST", `/api/change-reviews/${reviewId}/finish`);

    const answer = await terminal.call("review_feedback", { reviewId });

    expect(answer).toContain("élément introuvable");
    expect(await threadsOf(pageId)).toMatchObject([{ target: { kind: "element", xPct: 40, yPct: 12 } }]);
  });

  it("names the rendering and state a pin was placed in", async () => {
    const { terminal, reviewId, stepId } = await declared();
    await addPin(reviewId, stepId, "On mobile", { rendering: { format: "mobile", width: 390 } });
    await send("POST", `/api/change-reviews/${reviewId}/finish`);

    const answer = await terminal.call("review_feedback", { reviewId });

    expect(answer).toMatch(/\(vu en Mobile/);
  });
});
