import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { ChangeReview, Thread } from "@redline/shared";
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

describe("remarks", () => {
  const saveRemark = (reviewId: string, stepId: string, text: string) =>
    fetch(`${seam!.server.url}/api/change-reviews/${reviewId}/steps/${stepId}/remark`, { method: "PUT", headers: { "content-type": "application/json" }, body: JSON.stringify({ text }) });
  const threadsOf = async (pageId: string) => (await (await seam!.server.get(`/api/pages/${pageId}/threads`)).json()) as Thread[];

  it("saves a remark in place of the person's OK, edits it, and deletes it", async () => {
    const { reviewId } = await declared();
    const first = (await reviewOf(reviewId)).steps[0]!;
    await send("PUT", `/api/change-reviews/${reviewId}/steps/${first.id}/ok`);

    expect((await saveRemark(reviewId, first.id, "Too dense")).status).toBe(200);
    expect((await reviewOf(reviewId)).steps[0]!.answers).toMatchObject([{ kind: "remark", text: "Too dense", mine: true }]);

    await saveRemark(reviewId, first.id, "Too dense, move it up");
    const answers = (await reviewOf(reviewId)).steps[0]!.answers;
    expect(answers).toMatchObject([{ kind: "remark", text: "Too dense, move it up" }]);
    expect((await send("PUT", `/api/change-reviews/${reviewId}/steps/${first.id}/ok`)).status).toBe(409);

    expect((await send("DELETE", `/api/change-reviews/${reviewId}/remarks/${answers[0]!.id}`)).status).toBe(200);
    expect((await reviewOf(reviewId)).steps[0]!.answers).toEqual([]);
  });

  it("refuses an empty remark and any change once the review is finished", async () => {
    const { reviewId } = await declared();
    const first = (await reviewOf(reviewId)).steps[0]!;
    await saveRemark(reviewId, first.id, "Keep me");
    const remarkId = (await reviewOf(reviewId)).steps[0]!.answers[0]!.id;

    expect((await saveRemark(reviewId, first.id, "  ")).status).toBe(400);
    await send("POST", `/api/change-reviews/${reviewId}/finish`);

    expect((await saveRemark(reviewId, first.id, "Late")).status).toBe(409);
    expect((await send("DELETE", `/api/change-reviews/${reviewId}/remarks/${remarkId}`)).status).toBe(409);
    expect((await reviewOf(reviewId)).steps[0]!.answers).toMatchObject([{ text: "Keep me" }]);
  });

  it("never turns a remark into a held comment or a thread before the review is fetched", async () => {
    const { reviewId, pages } = await declared();
    const first = (await reviewOf(reviewId)).steps[0]!;
    await saveRemark(reviewId, first.id, "Too dense");

    expect(await threadsOf(pages.home)).toEqual([]);
    expect(await (await seam!.server.get(`/api/pages/${pages.home}/held`)).json()).toEqual([]);
    expect(await (await seam!.server.get(`/api/pages/${pages.home}/queue`)).json()).toEqual([]);
  });

  it("opens one thread per remark at fetch, taken by the fetching session, and lists them with their ids", async () => {
    const { terminal, reviewId, pages } = await declared();
    const steps = (await reviewOf(reviewId)).steps;
    await send("PUT", `/api/change-reviews/${reviewId}/steps/${steps[0]!.id}/ok`);
    await saveRemark(reviewId, steps[1]!.id, "Show the empty state\nabove the fold");
    await send("POST", `/api/change-reviews/${reviewId}/finish`);

    const answer = await terminal.call("review_feedback", { reviewId });

    const threads = await threadsOf(pages.home);
    expect(threads).toHaveLength(1);
    expect(threads[0]).toMatchObject({ body: "Show the empty state\nabove the fold", target: { kind: "artboard", artboard: "empty.html" } });
    expect(answer).toMatch(/Validated \(1\)[\s\S]*1\. Home · List/);
    expect(answer).toMatch(/Remarks \(1\)[\s\S]*2\. Home · Empty \(empty\.html\) · remark by [\s\S]*thread /);
    expect(answer).toContain(`thread ${threads[0]!.id}`);
    expect(answer).toContain("> Show the empty state");
    expect(answer).toContain("> above the fold");
    expect(await terminal.call("reply_in_thread", { threadId: threads[0]!.id, text: "Moved above the fold" })).toContain("Reply posted");
    expect((await threadsOf(pages.home))[0]!.replies.map((r) => r.body)).toEqual(["Moved above the fold"]);
  });

  it("lists the step with a remark as a remark, not as validated", async () => {
    const { terminal, reviewId } = await declared();
    const steps = (await reviewOf(reviewId)).steps;
    await saveRemark(reviewId, steps[0]!.id, "No");
    await send("POST", `/api/change-reviews/${reviewId}/finish`);

    const answer = await terminal.call("review_feedback", { reviewId });

    expect(answer).toMatch(/Validated \(0\)/);
    expect(answer).toMatch(/Remarks \(1\)/);
    expect(answer).toMatch(/Not seen \(2\)/);
  });

  it("counts remarks apart from OKs in the banner, and marks the review fetched at the first fetch", async () => {
    const { terminal, reviewId, pages } = await declared();
    const steps = (await reviewOf(reviewId)).steps;
    await send("PUT", `/api/change-reviews/${reviewId}/steps/${steps[0]!.id}/ok`);
    await saveRemark(reviewId, steps[1]!.id, "No");
    const banners = async () => (await (await seam!.server.get(`/api/pages/${pages.home}/change-reviews`)).json()) as { state: string; okCount: number; remarkCount: number }[];
    expect((await banners())[0]).toMatchObject({ okCount: 1, remarkCount: 1 });
    await send("POST", `/api/change-reviews/${reviewId}/finish`);

    await terminal.call("review_feedback", { reviewId });

    expect((await banners())[0]).toMatchObject({ state: "fetched", okCount: 1, remarkCount: 1 });
    expect(await reviewOf(reviewId)).toMatchObject({ state: "fetched" });
  });
});

describe("review_feedback without an id, and who can fetch", () => {
  const linkFolder = () => {
    mkdirSync(join(seam!.folder, ".redline"), { recursive: true });
    writeFileSync(join(seam!.folder, ".redline", "project.json"), JSON.stringify({ projectIds: [seam!.project.id] }));
  };
  const saveRemark = (reviewId: string, stepId: string, text: string) =>
    fetch(`${seam!.server.url}/api/change-reviews/${reviewId}/steps/${stepId}/remark`, { method: "PUT", headers: { "content-type": "application/json" }, body: JSON.stringify({ text }) });
  const threadsOf = async (pageId: string) => (await (await seam!.server.get(`/api/pages/${pageId}/threads`)).json()) as Thread[];
  const finishWithRemark = async (reviewId: string, text = "Too dense") => {
    const first = (await reviewOf(reviewId)).steps[0]!;
    await saveRemark(reviewId, first.id, text);
    await send("POST", `/api/change-reviews/${reviewId}/finish`);
  };

  it("fetches the only finished review of the folder's project, found without an id", async () => {
    const { terminal, reviewId, pages } = await declared();
    linkFolder();
    await finishWithRemark(reviewId);

    const answer = await terminal.call("review_feedback", {});

    expect(answer).toMatch(/Remarks \(1\)/);
    expect(await reviewOf(reviewId)).toMatchObject({ state: "fetched" });
    expect(await threadsOf(pages.home)).toHaveLength(1);
  });

  it("lists several finished reviews with their id, requester and finish date, and fetches none", async () => {
    const { terminal, reviewId, pages } = await declared();
    linkFolder();
    const otherFolder = await openTerminal(seam!, stops, "Mac-mini", {
      wrapApi: (api) => Object.assign(Object.create(api) as typeof api, { requestReview: (sessionId: string, request: Parameters<typeof api.requestReview>[1]) => api.requestReview(sessionId, { ...request, folder: "/work/other-folder" }) }),
    });
    const second = idOf(await otherFolder.call("request_review", { steps: [step(pages.settings, "settings.html")] }));
    await finishWithRemark(reviewId);
    await send("POST", `/api/change-reviews/${second}/finish`);

    const answer = await terminal.call("review_feedback", {});

    expect(answer).toMatch(/2 finished reviews wait/);
    expect(answer).toContain(reviewId);
    expect(answer).toContain(second);
    expect(await reviewOf(reviewId)).toMatchObject({ state: "finished" });
    expect(await reviewOf(second)).toMatchObject({ state: "finished" });
    expect(await threadsOf(pages.home)).toEqual([]);

    expect(await terminal.call("review_feedback", { reviewId: second })).toMatch(/Requested by/);
  });

  it("says the open reviews are not finished, with their progress, and handles nothing", async () => {
    const { terminal, reviewId } = await declared();
    linkFolder();
    const steps = (await reviewOf(reviewId)).steps;
    await send("PUT", `/api/change-reviews/${reviewId}/steps/${steps[0]!.id}/ok`);
    await saveRemark(reviewId, steps[1]!.id, "No");

    const answer = await terminal.call("review_feedback", {});

    expect(answer).toMatch(/not finished yet/);
    expect(answer).toContain(reviewId);
    expect(answer).toContain("2 / 3 steps seen, 1 remark");
    expect(await reviewOf(reviewId)).toMatchObject({ state: "open" });
  });

  it("says no review waits when the folder's project has none", async () => {
    seam = await startSeam2(new FakeEngine(() => []));
    linkFolder();
    const terminal = await openTerminal(seam, stops, "MacBook-Pro");

    expect(await terminal.call("review_feedback", {})).toMatch(/No review is waiting/);
  });

  it("lets another conversation fetch a review it did not request, and gives it the threads", async () => {
    const { reviewId, pages } = await declared();
    linkFolder();
    await finishWithRemark(reviewId, "From someone else");
    const other = await openTerminal(seam!, stops, "iMac");

    const answer = await other.call("review_feedback", {});

    const [thread] = await threadsOf(pages.home);
    expect(answer).toContain(`thread ${thread!.id}`);
    expect(await other.call("reply_in_thread", { threadId: thread!.id, text: "Done" })).toContain("Reply posted");
  });

  it("returns the same result marked already fetched on a second call, and creates no thread again", async () => {
    const { terminal, reviewId, pages } = await declared();
    await finishWithRemark(reviewId);
    const first = await terminal.call("review_feedback", { reviewId });

    const again = await terminal.call("review_feedback", { reviewId });

    expect(first).not.toMatch(/Already fetched/);
    expect(again).toMatch(/Already fetched on \d{4}-/);
    expect(again.replace(/^Already fetched.*\n/, "")).toBe(first);
    expect(await threadsOf(pages.home)).toHaveLength(1);
  });

  it("refuses a review request from a session that is not a terminal session (a background agent)", async () => {
    const { pages } = await declared();
    const { token } = (await (await seam!.server.get("/api/agent-token")).json()) as { token: string };

    const refused = await fetch(`${seam!.server.url}/agent-api/terminal-sessions/7d6f3f6e-0000-4000-8000-0000000000aa/reviews`, {
      method: "POST",
      headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
      body: JSON.stringify({ folder: "/work/x", steps: [step(pages.home, "list.html")] }),
    });

    expect(refused.status).toBe(403);
    expect(((await refused.json()) as { error: string }).error).toMatch(/only a terminal session/);
    expect(await (await seam!.server.get(`/api/pages/${pages.home}/change-reviews`)).json()).toHaveLength(1);
  });
});
