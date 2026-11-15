import { afterEach, describe, expect, it } from "vitest";
import type { ChangeReview } from "@redline/shared";
import { FakeEngine, startSeam2, type Seam2 } from "./support/seam2.js";
import { openTerminal, type Terminal } from "./support/terminal.js";

let seam: Seam2 | undefined;
const stops: (() => Promise<void>)[] = [];
afterEach(async () => {
  for (const stop of stops.splice(0)) await stop();
  await seam?.stop();
  seam = undefined;
});

const step = (pageId: string, artboard: string, extra: Record<string, unknown> = {}) => ({ pageId, artboard, changed: `Changed ${artboard}`, lookAt: "Look", question: "Fine?", ...extra });
const idOf = (answer: string) => /#\/reviews\/([0-9a-f-]{36})/.exec(answer)![1]!;
const reviewOf = async (id: string) => (await (await seam!.server.get(`/api/change-reviews/${id}`)).json()) as ChangeReview;
const send = (method: string, path: string) => fetch(`${seam!.server.url}${path}`, { method });
/** Page version ids, oldest first. */
const versionIds = async (pageId: string) => (await seam!.versions(pageId)).map((version) => version.id).reverse();

async function start(files: Record<string, string> = { "home.html": "<h1>Home</h1>" }): Promise<{ terminal: Terminal; pageId: string }> {
  seam = await startSeam2(new FakeEngine(() => []));
  const page = await seam.createPage(files, "Home");
  return { terminal: await openTerminal(seam, stops, "MacBook-Pro"), pageId: page.id };
}

describe("the baseline of a step", () => {
  it("is the version before the requester's first publish of the artboard in the series", async () => {
    const { terminal, pageId } = await start();
    await terminal.publish(pageId, "first");
    await terminal.publish(pageId, "second");
    const ids = await versionIds(pageId);

    const review = await reviewOf(idOf(await terminal.call("request_review", { steps: [step(pageId, "home.html")] })));

    expect(review.steps[0]).toMatchObject({ baselineVersionId: ids[0] });
    expect(review.steps[0]!.isNew).toBeUndefined();
  });

  it("is the version Claude gave, which always wins, and an unknown version is refused", async () => {
    const { terminal, pageId } = await start();
    await terminal.publish(pageId, "first");
    await terminal.publish(pageId, "second");
    const ids = await versionIds(pageId);

    const review = await reviewOf(idOf(await terminal.call("request_review", { steps: [step(pageId, "home.html", { baselineVersion: ids[1] })] })));
    const refused = await terminal.call("request_review", { steps: [step(pageId, "home.html", { baselineVersion: "nope" })] });

    expect(review.steps[0]).toMatchObject({ baselineVersionId: ids[1] });
    expect(refused).toMatch(/Unknown baseline versions/);
  });

  it("keeps the oldest automatic baseline when a declaration is merged, but a given version replaces it", async () => {
    const { terminal, pageId } = await start();
    await terminal.publish(pageId, "first");
    const reviewId = idOf(await terminal.call("request_review", { steps: [step(pageId, "home.html")] }));
    const ids = await versionIds(pageId);
    await terminal.publish(pageId, "second");

    await terminal.call("request_review", { steps: [step(pageId, "home.html")] });
    expect((await reviewOf(reviewId)).steps[0]).toMatchObject({ baselineVersionId: ids[0] });

    await terminal.call("request_review", { steps: [step(pageId, "home.html", { baselineVersion: ids[1] })] });
    expect((await reviewOf(reviewId)).steps[0]).toMatchObject({ baselineVersionId: ids[1] });
  });

  it("starts right after the last fetched review that covered the artboard", async () => {
    const { terminal, pageId } = await start();
    await terminal.publish(pageId, "first");
    const reviewId = idOf(await terminal.call("request_review", { steps: [step(pageId, "home.html")] }));
    await send("POST", `/api/change-reviews/${reviewId}/finish`);
    await terminal.call("review_feedback", { reviewId });
    const afterReview = (await versionIds(pageId)).at(-1);
    await terminal.publish(pageId, "second");

    const next = await reviewOf(idOf(await terminal.call("request_review", { steps: [step(pageId, "home.html")] })));

    expect(next.steps[0]).toMatchObject({ baselineVersionId: afterReview });
  });

  it("marks an artboard created in the series as new, without a version to show", async () => {
    const { terminal, pageId } = await start({ "other.html": "<h1>Other</h1>" });
    await terminal.publish(pageId, "adds home");

    const review = await reviewOf(idOf(await terminal.call("request_review", { steps: [step(pageId, "home.html")] })));

    expect(review.steps[0]).toMatchObject({ isNew: true });
    expect(review.steps[0]!.baselineVersionId).toBeUndefined();
  });
});
