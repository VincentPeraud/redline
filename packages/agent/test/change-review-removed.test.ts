import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { ChangeReview, Page, PageChangeReview, Thread } from "@redline/shared";
import { FakeEngine, startSeam2, type Seam2 } from "./support/seam2.js";
import { openTerminal, type Terminal } from "./support/terminal.js";

const FILES = { "home.html": "<!doctype html><h1>Home</h1>", "other.html": "<!doctype html><h1>Other</h1>", "style.css": "body{margin:0}" };

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
const declare = (page: Page, artboard: string) => ({ pageId: page.id, artboard, changed: `Changed ${artboard}`, lookAt: "Look", question: `Is ${artboard} fine?` });
/** What a person does to delete an artboard: a version without its file. */
const deleteArtboard = (page: Page, files: string[]) =>
  send("POST", `/api/pages/${page.id}/versions`, { files: Object.fromEntries(Object.entries(FILES).filter(([file]) => !files.includes(file))), message: `Delete ${files.join(", ")}`, origin: "user", confirmRemovals: true });

async function start(artboards = ["home.html", "other.html"]): Promise<{ terminal: Terminal; page: Page; second: Page; reviewId: string; stepId: (artboard: string) => Promise<string> }> {
  seam = await startSeam2(new FakeEngine(() => []));
  const page = await seam.createPage(FILES, "Home");
  const second = await seam.createPage({ "doc.html": "<!doctype html><h1>Doc</h1>" }, "Docs");
  const terminal = await openTerminal(seam, stops, "MacBook-Pro");
  const reviewId = idOf(await terminal.call("request_review", { steps: artboards.map((artboard) => declare(page, artboard)) }));
  const stepId = async (artboard: string) => (await reviewOf(reviewId)).steps.find((s) => s.artboard === artboard)!.id;
  return { terminal, page, second, reviewId, stepId };
}

describe("a deleted artboard", () => {
  it("leaves its step out of the count and the banner, still shown as removed", async () => {
    const { page, reviewId } = await start();

    await deleteArtboard(page, ["other.html"]);

    const review = await reviewOf(reviewId);
    expect(review.steps.map((s) => [s.artboard, s.removed])).toEqual([
      ["home.html", undefined],
      ["other.html", "deleted"],
    ]);
    expect((await bannersOf(page.id))[0]).toMatchObject({ stepCount: 1 });
  });
});

describe("a moved artboard", () => {
  it("keeps its step, now on the target page, without counting as modified", async () => {
    const { page, second, reviewId, stepId } = await start();
    await send("PUT", `/api/change-reviews/${reviewId}/steps/${await stepId("other.html")}/ok`);

    expect((await send("POST", `/api/pages/${page.id}/move-artboard`, { file: "other.html", targetPageId: second.id })).status).toBe(200);

    const step = (await reviewOf(reviewId)).steps.find((s) => s.artboard === "other.html")!;
    expect(step).toMatchObject({ pageId: second.id, pageTitle: "Docs" });
    expect(step.removed).toBeUndefined();
    expect(step.answers[0]).not.toHaveProperty("outdated");
    expect((await bannersOf(second.id))[0]).toMatchObject({ stepCount: 2 });
  });
});

describe("an archived page", () => {
  it("takes its steps out while archived and gives them back when unarchived before the review is finished", async () => {
    const { page, reviewId } = await start();

    await send("POST", `/api/pages/${page.id}/archive`);
    expect((await reviewOf(reviewId)).steps.map((s) => s.removed)).toEqual(["archived", "archived"]);

    await send("POST", `/api/pages/${page.id}/unarchive`);
    expect((await reviewOf(reviewId)).steps.map((s) => s.removed)).toEqual([undefined, undefined]);
  });

  it("does not give its steps back when unarchived after the review was finished", async () => {
    const { page, reviewId } = await start();
    await send("POST", `/api/pages/${page.id}/archive`);
    await send("POST", `/api/change-reviews/${reviewId}/finish`);

    await send("POST", `/api/pages/${page.id}/unarchive`);

    expect((await reviewOf(reviewId)).steps.map((s) => s.removed)).toEqual(["archived", "archived"]);
  });

  it("gives its steps back when a finished review is reopened and the page unarchived", async () => {
    const { page, reviewId, stepId } = await start();
    await send("PUT", `/api/change-reviews/${reviewId}/steps/${await stepId("home.html")}/remark`, { text: "Home is off" });
    await send("POST", `/api/pages/${page.id}/archive`);
    await send("POST", `/api/change-reviews/${reviewId}/finish`);
    await send("POST", `/api/change-reviews/${reviewId}/reopen`);

    await send("POST", `/api/pages/${page.id}/unarchive`);

    expect((await reviewOf(reviewId)).steps.map((s) => s.removed)).toEqual([undefined, undefined]);
  });
});

describe("review_feedback with removed artboards", () => {
  it("returns a remark on a deleted artboard as text, without a thread, and keeps the others as threads", async () => {
    const { terminal, page, reviewId, stepId } = await start();
    await send("PUT", `/api/change-reviews/${reviewId}/steps/${await stepId("home.html")}/remark`, { text: "Home is off" });
    await send("PUT", `/api/change-reviews/${reviewId}/steps/${await stepId("other.html")}/remark`, { text: "Other is off" });
    await deleteArtboard(page, ["other.html"]);
    await send("POST", `/api/change-reviews/${reviewId}/finish`);

    const answer = await terminal.call("review_feedback", { reviewId });

    expect(answer).toMatch(/Remarks \(2\)/);
    expect(answer).toMatch(/1\. Home · home\.html .*remark by .*thread (?!none)\S+/);
    expect(answer).toMatch(/-\. Home · other\.html .*artboard supprimé \(text only, no thread\).*thread none/);
    expect(answer).toContain("> Other is off");
    expect((await threadsOf(page.id)).map((t) => t.artboard)).toEqual(["home.html"]);
  });

  it("returns a remark on a page still archived as text marked page archivée", async () => {
    const { terminal, page, reviewId, stepId } = await start(["home.html"]);
    await send("PUT", `/api/change-reviews/${reviewId}/steps/${await stepId("home.html")}/remark`, { text: "Home is off" });
    await send("POST", `/api/change-reviews/${reviewId}/finish`);
    await send("POST", `/api/pages/${page.id}/archive`);

    const answer = await terminal.call("review_feedback", { reviewId });

    expect(answer).toMatch(/page archivée \(text only, no thread\)/);
    expect(answer).toContain("> Home is off");
    expect(await threadsOf(page.id)).toHaveLength(0);
  });

  it("lets a review whose steps were all removed be finished, and lists it with its remarks as text", async () => {
    const { terminal, page, reviewId, stepId } = await start();
    await send("PUT", `/api/change-reviews/${reviewId}/steps/${await stepId("home.html")}/remark`, { text: "Home is off" });
    await deleteArtboard(page, ["home.html", "other.html"]);

    expect((await reviewOf(reviewId)).state).toBe("open");
    expect((await send("POST", `/api/change-reviews/${reviewId}/finish`)).status).toBe(200);
    mkdirSync(join(seam!.folder, ".redline"), { recursive: true });
    writeFileSync(join(seam!.folder, ".redline", "project.json"), JSON.stringify({ projectIds: [seam!.project.id] }));
    const answer = await terminal.call("review_feedback", {});

    expect(answer).toMatch(/Validated \(0\)/);
    expect(answer).toMatch(/Remarks \(1\)[\s\S]*artboard supprimé[\s\S]*> Home is off/);
    expect(answer).toMatch(/Not seen \(0\)/);
  });
});

describe("a review with nothing left", () => {
  it("is filed by itself when every artboard was deleted and no remark is left, and its banner goes", async () => {
    const { terminal, page, reviewId } = await start();
    expect(await bannersOf(page.id)).toHaveLength(1);

    await deleteArtboard(page, ["home.html", "other.html"]);

    expect((await reviewOf(reviewId)).state).toBe("filed");
    expect(await bannersOf(page.id)).toEqual([]);
    expect(await terminal.call("review_feedback", { reviewId })).toMatch(/plus rien à revoir/);
  });

  it("is not filed while an archived page may come back", async () => {
    const { page, reviewId } = await start();

    await send("POST", `/api/pages/${page.id}/archive`);

    expect((await reviewOf(reviewId)).state).toBe("open");
  });

  it("is not filed by a move: the steps follow their artboards", async () => {
    const { page, second, reviewId } = await start(["home.html"]);

    await send("POST", `/api/pages/${page.id}/move-artboard`, { file: "home.html", targetPageId: second.id });

    expect((await reviewOf(reviewId)).state).toBe("open");
    expect((await bannersOf(second.id))).toHaveLength(1);
  });
});
