import { afterEach, describe, expect, it } from "vitest";
import type { ChangeReview } from "@redline/shared";
import { FakeEngine, startSeam2, type Seam2 } from "./support/seam2.js";
import { openTerminal, type Terminal } from "./support/terminal.js";

const PAGE_FILES = {
  "list.html": "<!doctype html><h1>List</h1>",
  "empty.html": "<!doctype html><h1>Empty</h1>",
  "manifest.json": JSON.stringify({
    artboards: [
      { file: "empty.html", title: "Empty", x: 1300, y: 0, width: 1200, height: 800 },
      { file: "list.html", title: "List", x: 0, y: 0, width: 1200, height: 800 },
    ],
  }),
};
const SETTINGS_FILES = { "settings.html": "<!doctype html><h1>Settings</h1>" };

let seam: Seam2 | undefined;
const stops: (() => Promise<void>)[] = [];
afterEach(async () => {
  for (const stop of stops.splice(0)) await stop();
  await seam?.stop();
  seam = undefined;
});

const step = (pageId: string, artboard: string, question = `Is ${artboard} fine?`) => ({ pageId, artboard, changed: `Changed ${artboard}`, lookAt: `Look at ${artboard}`, question });
const idOf = (answer: string) => /#\/reviews\/([0-9a-f-]{36})/.exec(answer)![1]!;
const send = (method: string, path: string) => fetch(`${seam!.server.url}${path}`, { method });
const reviewOf = async (id: string) => (await (await seam!.server.get(`/api/change-reviews/${id}`)).json()) as ChangeReview;

async function declared(): Promise<{ terminal: Terminal; reviewId: string; pages: { home: string; settings: string } }> {
  seam = await startSeam2(new FakeEngine(() => []));
  const home = await seam.createPage(PAGE_FILES, "Home");
  const settings = await seam.createPage(SETTINGS_FILES, "Settings");
  const terminal = await openTerminal(seam, stops, "MacBook-Pro");
  const answer = await terminal.call("request_review", { steps: [step(settings.id, "settings.html"), step(home.id, "empty.html"), step(home.id, "list.html")] });
  return { terminal, reviewId: idOf(answer), pages: { home: home.id, settings: settings.id } };
}

describe("request_review", () => {
  it("answers the review link and says nothing is pushed until review_feedback is called", async () => {
    const { reviewId, terminal } = await declared();
    const answer = await terminal.call("request_review", { steps: [step((await reviewOf(reviewId)).steps[0]!.pageId, "list.html")] });

    expect(answer).toContain(`/#/reviews/`);
    expect(answer).toMatch(/Nothing is pushed/);
    expect(answer).toContain("review_feedback");
  });

  it("opens the review for the requester's project with the steps in page order then reading order", async () => {
    const { reviewId } = await declared();

    const review = await reviewOf(reviewId);

    expect(review).toMatchObject({ projectTitle: "Acme", state: "open", requester: { folder: expect.any(String) } });
    expect(review.steps.map((s) => `${s.pageTitle}/${s.artboard}`)).toEqual(["Home/list.html", "Home/empty.html", "Settings/settings.html"]);
    expect(review.steps[0]).toMatchObject({ artboardTitle: "List", changed: "Changed list.html", lookAt: "Look at list.html", question: "Is list.html fine?", answers: [] });
  });

  it("refuses unknown artboards and lists them", async () => {
    const { terminal, pages } = await declared();

    const answer = await terminal.call("request_review", { steps: [step(pages.home, "list.html"), step(pages.home, "nope.html")] });

    expect(answer).toMatch(/nope\.html/);
    expect(answer).not.toMatch(/#\/reviews\//);
  });
});

describe("answers and finishing", () => {
  it("records a signed OK, cancels it, and locks the review once finished", async () => {
    const { reviewId } = await declared();
    const first = (await reviewOf(reviewId)).steps[0]!;

    const answered = await send("PUT", `/api/change-reviews/${reviewId}/steps/${first.id}/ok`);
    expect(answered.status).toBe(200);
    expect((await reviewOf(reviewId)).steps[0]!.answers).toMatchObject([{ kind: "ok", mine: true }]);

    await send("DELETE", `/api/change-reviews/${reviewId}/steps/${first.id}/ok`);
    expect((await reviewOf(reviewId)).steps[0]!.answers).toEqual([]);

    await send("PUT", `/api/change-reviews/${reviewId}/steps/${first.id}/ok`);
    expect((await send("POST", `/api/change-reviews/${reviewId}/finish`)).status).toBe(200);
    expect(await reviewOf(reviewId)).toMatchObject({ state: "finished" });
    expect((await send("PUT", `/api/change-reviews/${reviewId}/steps/${first.id}/ok`)).status).toBe(409);
    expect((await send("DELETE", `/api/change-reviews/${reviewId}/steps/${first.id}/ok`)).status).toBe(409);
  });

  it("says the review is not finished yet, with its progress, and handles nothing", async () => {
    const { terminal, reviewId } = await declared();
    const first = (await reviewOf(reviewId)).steps[0]!;
    await send("PUT", `/api/change-reviews/${reviewId}/steps/${first.id}/ok`);

    const answer = await terminal.call("review_feedback", { reviewId });

    expect(answer).toMatch(/not finished yet/);
    expect(answer).toContain("1 / 3");
  });

  it("gives the requester, the finisher, the validated steps with who validated them and the steps not seen", async () => {
    const { terminal, reviewId } = await declared();
    const steps = (await reviewOf(reviewId)).steps;
    await send("PUT", `/api/change-reviews/${reviewId}/steps/${steps[0]!.id}/ok`);
    await send("PUT", `/api/change-reviews/${reviewId}/steps/${steps[2]!.id}/ok`);
    await send("POST", `/api/change-reviews/${reviewId}/finish`);

    const answer = await terminal.call("review_feedback", { reviewId });

    expect(answer).toMatch(/Requested by/);
    expect(answer).toMatch(/Finished by/);
    expect(answer).toMatch(/Validated \(2\)[\s\S]*1\. Home · List[\s\S]*3\. Settings · settings\.html/);
    expect(answer).toMatch(/Not seen \(1\)[\s\S]*2\. Home · Empty/);
  });

  it("answers 404 for a review that does not exist", async () => {
    await declared();
    expect((await seam!.server.get("/api/change-reviews/00000000-0000-4000-8000-000000000000")).status).toBe(404);
  });
});
