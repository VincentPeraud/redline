import { afterEach, describe, expect, it } from "vitest";
import type { ChangeReview, Page } from "@redline/shared";
import { FakeEngine, startSeam2, type Seam2 } from "./support/seam2.js";
import { openTerminal, type Terminal } from "./support/terminal.js";

const FILES = { "home.html": "<!doctype html><h1>Home</h1>", "other.html": "<!doctype html><h1>Other</h1>" };

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
const declare = (page: Page, artboard: string) => ({ pageId: page.id, artboard, changed: `Changed ${artboard}`, lookAt: "Look", question: `Is ${artboard} fine?` });

async function start(): Promise<{ terminal: Terminal; page: Page; reviewId: string; stepId: (artboard: string) => Promise<string> }> {
  seam = await startSeam2(new FakeEngine(() => []));
  const page = await seam.createPage(FILES, "Home");
  const terminal = await openTerminal(seam, stops, "MacBook-Pro");
  const reviewId = idOf(await terminal.call("request_review", { steps: [declare(page, "home.html"), declare(page, "other.html")] }));
  const stepId = async (artboard: string) => (await reviewOf(reviewId)).steps.find((s) => s.artboard === artboard)!.id;
  return { terminal, page, reviewId, stepId };
}

describe("an artboard republished after answers", () => {
  it("outdates the answers on the artboard that changed only, naming the author", async () => {
    const { terminal, page, reviewId, stepId } = await start();
    for (const artboard of ["home.html", "other.html"]) await send("PUT", `/api/change-reviews/${reviewId}/steps/${await stepId(artboard)}/ok`);

    await terminal.publish(page.id, "Home changed");

    const steps = (await reviewOf(reviewId)).steps;
    expect(steps.find((s) => s.artboard === "home.html")).toMatchObject({ answers: [{ kind: "ok", outdated: true }], modifiedBy: "Claude (MacBook-Pro)" });
    expect(steps.find((s) => s.artboard === "other.html")!.answers[0]).not.toHaveProperty("outdated");
  });

  it("is not modified by a tweak-only version", async () => {
    const { page, reviewId, stepId } = await start();
    await send("PUT", `/api/change-reviews/${reviewId}/steps/${await stepId("home.html")}/ok`);

    await send("POST", `/api/pages/${page.id}/tweaks`, { id: "accent", value: "#0f766e" });

    expect((await reviewOf(reviewId)).steps.find((s) => s.artboard === "home.html")!.answers[0]).not.toHaveProperty("outdated");
  });

  it("replaces an outdated OK when the person validates again", async () => {
    const { terminal, page, reviewId, stepId } = await start();
    const id = await stepId("home.html");
    await send("PUT", `/api/change-reviews/${reviewId}/steps/${id}/ok`);
    await terminal.publish(page.id, "Home changed");

    expect((await send("PUT", `/api/change-reviews/${reviewId}/steps/${id}/ok`)).status).toBe(200);

    const step = (await reviewOf(reviewId)).steps.find((s) => s.id === id)!;
    expect(step.answers).toHaveLength(1);
    expect(step.answers[0]).not.toHaveProperty("outdated");
  });

  it("keeps an outdated remark until its author clears it, then lets them validate", async () => {
    const { terminal, page, reviewId, stepId } = await start();
    const id = await stepId("home.html");
    await send("PUT", `/api/change-reviews/${reviewId}/steps/${id}/remark`, { text: "Move it up" });
    await terminal.publish(page.id, "Home changed");

    const remark = (await reviewOf(reviewId)).steps.find((s) => s.id === id)!.answers[0]!;
    expect(remark).toMatchObject({ kind: "remark", text: "Move it up", outdated: true });
    expect((await send("PUT", `/api/change-reviews/${reviewId}/steps/${id}/ok`)).status).toBe(409);

    await send("DELETE", `/api/change-reviews/${reviewId}/remarks/${remark.id}`);
    expect((await send("PUT", `/api/change-reviews/${reviewId}/steps/${id}/ok`)).status).toBe(200);
    expect((await reviewOf(reviewId)).steps.find((s) => s.id === id)!.answers).toMatchObject([{ kind: "ok" }]);
  });

  it("gives Claude a modified OK-only step as not seen", async () => {
    const { terminal, page, reviewId, stepId } = await start();
    await send("PUT", `/api/change-reviews/${reviewId}/steps/${await stepId("home.html")}/ok`);
    await send("PUT", `/api/change-reviews/${reviewId}/steps/${await stepId("other.html")}/ok`);
    await terminal.publish(page.id, "Home changed");
    await send("POST", `/api/change-reviews/${reviewId}/finish`);

    const answer = await terminal.call("review_feedback", { reviewId });

    expect(answer).toMatch(/Validated \(1\)[\s\S]*"Home · other\.html"/);
    expect(answer).toMatch(/Not seen \(1\)[\s\S]*"Home · home\.html" · modifié après le OK/);
  });

  it("gives Claude a modified remark as a remark marked as modified since", async () => {
    const { terminal, page, reviewId, stepId } = await start();
    await send("PUT", `/api/change-reviews/${reviewId}/steps/${await stepId("home.html")}/remark`, { text: "Too dense" });
    await terminal.publish(page.id, "Home changed");
    await send("POST", `/api/change-reviews/${reviewId}/finish`);

    const answer = await terminal.call("review_feedback", { reviewId });

    expect(answer).toMatch(/Feedback \(1 on 1 step\)[\s\S]*artboard modifié depuis la remarque/);
    expect(answer).not.toMatch(/modifié après le OK/);
  });
});
