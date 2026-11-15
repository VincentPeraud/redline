import { afterEach, describe, expect, it } from "vitest";
import type { ChangeReview, Page, Thread } from "@redline/shared";
import { FakeEngine, startSeam2, type Seam2 } from "./support/seam2.js";
import { openTerminal, type Terminal } from "./support/terminal.js";

const FILES = {
  "home.html": "<!doctype html><h1>Home</h1>",
  "empty.html": "<!doctype html><h1>Empty</h1>",
  "manifest.json": JSON.stringify({
    artboards: [
      { file: "home.html", title: "List", x: 0, y: 0, width: 1200, height: 800 },
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
const texts = { changed: "A badge next to the name", lookAt: "The example is enough", question: "Is the badge fine?" };

/** Two pages with two artboards each: a group over three of them, and the fourth declared alone. */
async function start(): Promise<{ terminal: Terminal; home: Page; settings: Page; reviewId: string; groupId: string }> {
  seam = await startSeam2(new FakeEngine(() => []));
  const home = await seam.createPage(FILES, "Home");
  const settings = await seam.createPage(FILES, "Settings");
  const terminal = await openTerminal(seam, stops, "MacBook-Pro");
  const reviewId = idOf(
    await terminal.call("request_review", {
      steps: [
        { pageId: home.id, artboard: "home.html", title: "Badge cmux", others: [{ pageId: home.id, artboard: "empty.html" }, { pageId: settings.id, artboard: "home.html" }], ...texts },
        { pageId: settings.id, artboard: "empty.html", ...texts },
      ],
    }),
  );
  const groupId = (await reviewOf(reviewId)).steps.find((step) => step.others)!.id;
  return { terminal, home, settings, reviewId, groupId };
}

describe("declaring a grouped step", () => {
  it("is one step named with its size, listed after the single steps when it spans several pages", async () => {
    const { reviewId } = await start();

    const review = await reviewOf(reviewId);

    expect(review.steps.map((step) => `${step.title ?? step.artboard}`)).toEqual(["empty.html", "Badge cmux"]);
    expect(review.steps[1]).toMatchObject({
      artboard: "home.html",
      artboardTitle: "List",
      others: [
        { artboard: "empty.html", pageTitle: "Home", artboardTitle: "Empty" },
        { artboard: "home.html", pageTitle: "Settings" },
      ],
    });
  });

  it("refuses an artboard listed twice and an unknown artboard of the group", async () => {
    const { terminal, home } = await start();

    const twice = await terminal.call("request_review", { steps: [{ pageId: home.id, artboard: "home.html", others: [{ pageId: home.id, artboard: "home.html" }], ...texts }] });
    const unknown = await terminal.call("request_review", { steps: [{ pageId: home.id, artboard: "home.html", others: [{ pageId: home.id, artboard: "nope.html" }], ...texts }] });

    expect(twice).toMatch(/once/);
    expect(unknown).toMatch(/nope\.html/);
  });

  it("makes an artboard of the group declared alone a new single step", async () => {
    const { terminal, home, reviewId } = await start();

    await terminal.call("request_review", { steps: [{ pageId: home.id, artboard: "empty.html", ...texts }] });

    const review = await reviewOf(reviewId);
    expect(review.steps).toHaveLength(3);
    expect(review.steps.filter((step) => step.others)).toHaveLength(1);
  });
});

describe("answering a group", () => {
  it("validates the whole group with one OK", async () => {
    const { reviewId, groupId } = await start();

    expect((await send("PUT", `/api/change-reviews/${reviewId}/steps/${groupId}/ok`)).status).toBe(200);

    expect((await reviewOf(reviewId)).steps.find((step) => step.id === groupId)!.answers).toMatchObject([{ kind: "ok", mine: true }]);
  });

  it("goes back to Modifié when one artboard of the group is republished, marking that artboard", async () => {
    const { terminal, settings, reviewId, groupId } = await start();
    await send("PUT", `/api/change-reviews/${reviewId}/steps/${groupId}/ok`);

    await terminal.publish(settings.id, "Settings changed");

    const group = (await reviewOf(reviewId)).steps.find((step) => step.id === groupId)!;
    expect(group.answers[0]).toMatchObject({ outdated: true });
    expect(group).not.toHaveProperty("modifiedAt");
    expect(group.others![0]).not.toHaveProperty("modified");
    expect(group.others![1]).toMatchObject({ modified: true, modifiedBy: "Claude (MacBook-Pro)" });
  });

  it("validates again on the new versions", async () => {
    const { terminal, settings, reviewId, groupId } = await start();
    await send("PUT", `/api/change-reviews/${reviewId}/steps/${groupId}/ok`);
    await terminal.publish(settings.id, "Settings changed");

    await send("PUT", `/api/change-reviews/${reviewId}/steps/${groupId}/ok`);

    const group = (await reviewOf(reviewId)).steps.find((step) => step.id === groupId)!;
    expect(group.answers).toHaveLength(1);
    expect(group.answers[0]).not.toHaveProperty("outdated");
    expect(group.others![1]).not.toHaveProperty("modified");
  });

  it("does not touch a single step on the same artboard when another group artboard is republished", async () => {
    const { terminal, home, reviewId } = await start();
    const single = (await reviewOf(reviewId)).steps.find((step) => !step.others)!;
    await send("PUT", `/api/change-reviews/${reviewId}/steps/${single.id}/ok`);

    await terminal.publish(home.id, "Home changed");

    expect((await reviewOf(reviewId)).steps.find((step) => step.id === single.id)!.answers[0]).not.toHaveProperty("outdated");
  });

  it("attaches a remark to the artboard it was started on, and keeps it there when edited", async () => {
    const { reviewId, groupId, settings } = await start();
    const path = `/api/change-reviews/${reviewId}/steps/${groupId}/remark`;

    await send("PUT", path, { text: "Too big", pageId: settings.id, artboard: "home.html" });
    await send("PUT", path, { text: "Too big on mobile" });

    expect((await reviewOf(reviewId)).steps.find((step) => step.id === groupId)!.answers).toMatchObject([{ kind: "remark", text: "Too big on mobile", on: { pageId: settings.id, artboard: "home.html" } }]);
  });

  it("refuses a remark on an artboard that is not in the step", async () => {
    const { reviewId, groupId, settings } = await start();

    const response = await send("PUT", `/api/change-reviews/${reviewId}/steps/${groupId}/remark`, { text: "Hm", pageId: settings.id, artboard: "empty.html" });

    expect(response.status).toBe(400);
  });
});

describe("a moved artboard of a group", () => {
  it("stays in the group on its new page, keeps its remark and does not count as modified", async () => {
    const { home, reviewId, groupId } = await start();
    const third = await seam!.createPage({ "other.html": "<!doctype html><h1>Other</h1>" }, "Third");
    await send("PUT", `/api/change-reviews/${reviewId}/steps/${groupId}/remark`, { text: "Too big", pageId: home.id, artboard: "empty.html" });

    const moved = await send("POST", `/api/pages/${home.id}/move-artboard`, { file: "empty.html", targetPageId: third.id });

    expect(moved.status).toBe(200);
    const group = (await reviewOf(reviewId)).steps.find((step) => step.id === groupId)!;
    expect(group.others!.map((member) => `${member.pageTitle}/${member.artboard}`)).toEqual(["Third/empty.html", "Settings/home.html"]);
    expect(group.answers[0]).toMatchObject({ on: { pageId: third.id, artboard: "empty.html" } });
    expect(group.answers[0]).not.toHaveProperty("outdated");
  });
});

describe("fetching a grouped step", () => {
  it("opens the remark thread on its artboard, citing the others, and lists the group by name", async () => {
    const { terminal, home, settings, reviewId, groupId } = await start();
    await send("PUT", `/api/change-reviews/${reviewId}/steps/${groupId}/remark`, { text: "Too big", pageId: settings.id, artboard: "home.html" });
    await send("POST", `/api/change-reviews/${reviewId}/finish`);

    const answer = await terminal.call("review_feedback", { reviewId });

    const threads = await threadsOf(settings.id);
    expect(threads).toHaveLength(1);
    expect(threads[0]).toMatchObject({ target: { kind: "artboard", artboard: "home.html" } });
    expect(threads[0]!.body).toMatch(/^Too big\n\nRemarque sur le groupe « Badge cmux \(3 artboards\) »[\s\S]*Home · List, Home · Empty/);
    expect(await threadsOf(home.id)).toEqual([]);
    expect(answer).toMatch(/"Badge cmux \(3 artboards\)" \("Settings · List"\) · remark by/);
    expect(answer).toContain("The same change also concerns: \"Home · List\", \"Home · Empty\".");
    expect(answer).toContain(`thread ${threads[0]!.id}`);
  });

  it("puts a remark written on the example on the example", async () => {
    const { terminal, home, reviewId, groupId } = await start();
    await send("PUT", `/api/change-reviews/${reviewId}/steps/${groupId}/remark`, { text: "Move it" });
    await send("POST", `/api/change-reviews/${reviewId}/finish`);

    await terminal.call("review_feedback", { reviewId });

    expect(await threadsOf(home.id)).toMatchObject([{ target: { kind: "artboard", artboard: "home.html" } }]);
  });
});
