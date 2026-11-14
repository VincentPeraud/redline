import { afterEach, describe, expect, it } from "vitest";
import type { ChangeReview, Page, PageChangeReview, Project } from "@redline/shared";
import { FakeEngine, startSeam2, type Seam2 } from "./support/seam2.js";
import { openTerminal, type Terminal } from "./support/terminal.js";

const HOME_FILES = {
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
const send = (method: string, path: string, body?: unknown) =>
  fetch(`${seam!.server.url}${path}`, { method, ...(body === undefined ? {} : { headers: { "content-type": "application/json" }, body: JSON.stringify(body) }) });
const reviewOf = async (id: string) => (await (await seam!.server.get(`/api/change-reviews/${id}`)).json()) as ChangeReview;
const bannersOf = async (pageId: string) => (await (await seam!.server.get(`/api/pages/${pageId}/change-reviews`)).json()) as PageChangeReview[];
const stepNames = (review: ChangeReview) => review.steps.map((s) => `${s.pageTitle}/${s.artboard}`);

async function start(): Promise<{ terminal: Terminal; home: Page; settings: Page }> {
  seam = await startSeam2(new FakeEngine(() => []));
  const home = await seam.createPage(HOME_FILES, "Home");
  const settings = await seam.createPage(SETTINGS_FILES, "Settings");
  return { terminal: await openTerminal(seam, stops, "MacBook-Pro"), home, settings };
}

/** A terminal of another conversation (another folder) of the same person. */
const otherConversation = (folder: string) =>
  openTerminal(seam!, stops, "Mac-mini", {
    wrapApi: (api) => Object.assign(Object.create(api) as typeof api, { requestReview: (sessionId: string, request: Parameters<typeof api.requestReview>[1]) => api.requestReview(sessionId, { ...request, folder }) }),
  });

describe("a review over several pages", () => {
  it("orders the steps by page order then reading order, whatever the order of the declaration", async () => {
    const { terminal, home, settings } = await start();

    const id = idOf(await terminal.call("request_review", { steps: [step(settings.id, "settings.html"), step(home.id, "empty.html"), step(home.id, "list.html")] }));

    expect(stepNames(await reviewOf(id))).toEqual(["Home/list.html", "Home/empty.html", "Settings/settings.html"]);
    expect((await bannersOf(settings.id))[0]).toMatchObject({ id, stepCount: 3, pageTitles: ["Home", "Settings"] });
  });
});

describe("merging a declaration", () => {
  it("merges a new declaration of the same requester into the open review, in page order, and says so", async () => {
    const { terminal, home, settings } = await start();
    const id = idOf(await terminal.call("request_review", { steps: [step(settings.id, "settings.html")] }));

    const answer = await terminal.call("request_review", { steps: [step(home.id, "list.html")] });

    expect(idOf(answer)).toBe(id);
    expect(answer).toMatch(/merged/i);
    expect(answer).toContain("2 steps");
    expect(stepNames(await reviewOf(id))).toEqual(["Home/list.html", "Settings/settings.html"]);
    expect(await bannersOf(home.id)).toHaveLength(1);
  });

  it("keeps the answers of the steps already there when the review grows", async () => {
    const { terminal, home, settings } = await start();
    const id = idOf(await terminal.call("request_review", { steps: [step(settings.id, "settings.html")] }));
    const first = (await reviewOf(id)).steps[0]!;
    await send("PUT", `/api/change-reviews/${id}/steps/${first.id}/ok`);

    await terminal.call("request_review", { steps: [step(home.id, "list.html")] });

    const review = await reviewOf(id);
    expect(review.steps[1]).toMatchObject({ id: first.id, artboard: "settings.html", answers: [{ kind: "ok" }] });
    expect(review.steps[0]!.answers).toEqual([]);
  });

  it("gives a redeclared step the new question and keeps its remark", async () => {
    const { terminal, home } = await start();
    const id = idOf(await terminal.call("request_review", { steps: [step(home.id, "list.html", "Old question?"), step(home.id, "empty.html")] }));
    const first = (await reviewOf(id)).steps[0]!;
    await send("PUT", `/api/change-reviews/${id}/steps/${first.id}/remark`, { text: "Too dense" });

    await terminal.call("request_review", { steps: [step(home.id, "list.html", "New question?")] });

    const review = await reviewOf(id);
    expect(review.steps).toHaveLength(2);
    expect(review.steps[0]).toMatchObject({ id: first.id, question: "New question?", answers: [{ kind: "remark", text: "Too dense" }] });
  });

  it("opens a second review for another requester and shows one banner per review", async () => {
    const { terminal, home } = await start();
    const first = idOf(await terminal.call("request_review", { steps: [step(home.id, "list.html")] }));
    const other = await otherConversation("/work/other-folder");

    const second = idOf(await other.call("request_review", { steps: [step(home.id, "empty.html")] }));

    expect(second).not.toBe(first);
    expect((await reviewOf(second)).requester.folder).toBe("other-folder");
    expect((await bannersOf(home.id)).map((banner) => banner.id)).toEqual([first, second]);
  });

  it("creates a new review and warns when the previous one is finished but not fetched", async () => {
    const { terminal, home } = await start();
    const first = idOf(await terminal.call("request_review", { steps: [step(home.id, "list.html")] }));
    await send("POST", `/api/change-reviews/${first}/finish`);

    const answer = await terminal.call("request_review", { steps: [step(home.id, "empty.html")] });

    expect(idOf(answer)).not.toBe(first);
    expect(answer).toContain("your previous review is finished but was not fetched");
    expect((await reviewOf(first)).state).toBe("finished");
  });

  it("does not warn once the previous review was fetched", async () => {
    const { terminal, home } = await start();
    const first = idOf(await terminal.call("request_review", { steps: [step(home.id, "list.html")] }));
    await send("POST", `/api/change-reviews/${first}/finish`);
    await terminal.call("review_feedback", { reviewId: first });

    const answer = await terminal.call("request_review", { steps: [step(home.id, "empty.html")] });

    expect(idOf(answer)).not.toBe(first);
    expect(answer).not.toContain("was not fetched");
  });
});

describe("refusals", () => {
  it("lists the unknown files and the artboards of another project, and creates nothing", async () => {
    const { terminal, home } = await start();
    const other = (await (await seam!.server.post("/api/projects", { title: "Other" })).json()) as Project;
    const foreign = (await (await seam!.server.post(`/api/projects/${other.id}/pages`, { title: "Foreign", files: { "x.html": "<h1>x</h1>" } })).json()) as Page;

    const answer = await terminal.call("request_review", { steps: [step(home.id, "list.html"), step(home.id, "nope.html"), step(foreign.id, "x.html")] });

    expect(answer).toContain("nope.html");
    expect(answer).toContain("A review covers one project only");
    expect(answer).toContain(`${foreign.id}: x.html`);
    expect(answer).not.toMatch(/#\/reviews\//);
    expect(await bannersOf(home.id)).toEqual([]);
  });
});

describe("the label", () => {
  it("is kept on the review, and a later declaration can rename it", async () => {
    const { terminal, home } = await start();
    const id = idOf(await terminal.call("request_review", { label: "Agora mock-ups", steps: [step(home.id, "list.html")] }));
    expect((await reviewOf(id)).requester.label).toBe("Agora mock-ups");

    await terminal.call("request_review", { label: "Agora v2", steps: [step(home.id, "empty.html")] });

    expect((await reviewOf(id)).requester.label).toBe("Agora v2");
    expect((await bannersOf(home.id))[0]!.requester.label).toBe("Agora v2");
  });
});
