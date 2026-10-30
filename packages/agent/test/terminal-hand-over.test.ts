import { afterEach, describe, expect, it } from "vitest";
import type { QueueEntry, Thread } from "@redline/shared";
import { FakeEngine, startSeam2, type Seam2 } from "./support/seam2.js";
import { openTerminal } from "./support/terminal.js";

const PAGE_FILES = {
  "home.html": "<!doctype html><h1>Home</h1>",
  "manifest.json": JSON.stringify({ artboards: [{ file: "home.html" }] }),
};

let seam: Seam2 | undefined;
const stops: (() => Promise<void>)[] = [];
afterEach(async () => {
  for (const stop of stops.splice(0)) await stop();
  await seam?.stop();
  seam = undefined;
});

const open = (machine: string) => openTerminal(seam!, stops, machine);

async function until(condition: () => boolean | Promise<boolean>, what: string): Promise<void> {
  const deadline = Date.now() + 5_000;
  while (!(await condition())) {
    if (Date.now() > deadline) throw new Error(`Timed out waiting for ${what}`);
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
}

const queueOf = async (pageId: string) => (await (await seam!.server.get(`/api/pages/${pageId}/queue`)).json()) as QueueEntry[];
const threadsOf = async (pageId: string) => (await (await seam!.server.get(`/api/pages/${pageId}/threads`)).json()) as Thread[];
const holder = async (pageId: string) => (await (await seam!.server.get(`/api/pages/${pageId}/terminal-holder`)).json()) as { folder: string } | null;
const heldComment = async (pageId: string, body: string) =>
  (await (await seam!.server.post(`/api/pages/${pageId}/threads`, { artboard: "home.html", selector: "h1", xPct: 5, yPct: 5, body, held: true })).json()) as Thread;

const answeringEngine = () =>
  new FakeEngine((run) => [
    ...[...run.message.matchAll(/thread id: ([0-9a-f-]{36})\)/g)].map((m) => ({ replyInThread: { threadId: m[1], text: "Agent answer" } })),
    { type: "result" as const, summary: "Agent run" },
  ]);

describe("handing work over from the terminal session to the agent", () => {
  it("hands one waiting thread over: the agent answers it, the other keeps waiting, the page stays held, later replies go to the agent", async () => {
    const engine = answeringEngine();
    seam = await startSeam2(engine);
    const page = await seam.createPage(PAGE_FILES);
    const terminal = await open("MacBook-Pro");
    await terminal.publish(page.id, "First");
    const mine = await seam.pinThread(page.id, "home.html", "Mine");
    const other = await seam.pinThread(page.id, "home.html", "Other");
    await until(async () => (await queueOf(page.id)).length === 2, "both threads to wait");

    const res = await seam.server.post(`/api/threads/${mine.id}/hand-over`, {});
    expect(res.status).toBe(204);
    await seam.waitForWorkEnd(1);

    expect(engine.runs).toHaveLength(1);
    expect(engine.runs[0].message).toContain(mine.id);
    expect(engine.runs[0].message).not.toContain(other.id);
    expect(await queueOf(page.id)).toEqual([expect.objectContaining({ threadIds: [other.id], reason: "terminal" })]);
    expect(await holder(page.id)).toMatchObject({ folder: "/work/MacBook-Pro" });

    await seam.server.post(`/api/threads/${mine.id}/messages`, { body: "More please" });
    await seam.waitForWorkEnd(2);
    expect(engine.runs.map((r) => r.resume)).toEqual([false, true]);
    expect(await queueOf(page.id)).toEqual([expect.objectContaining({ threadIds: [other.id] })]);
  });

  it("takes a thread out of a waiting batch and leaves the rest waiting", async () => {
    const engine = answeringEngine();
    seam = await startSeam2(engine);
    const page = await seam.createPage(PAGE_FILES);
    const terminal = await open("MacBook-Pro");
    await terminal.publish(page.id, "First");
    const first = await heldComment(page.id, "One");
    const second = await heldComment(page.id, "Two");
    await seam.server.post(`/api/pages/${page.id}/send-held`, {});
    await until(async () => (await queueOf(page.id)).length === 1, "the batch to wait");

    await seam.server.post(`/api/threads/${second.id}/hand-over`, {});
    await seam.waitForWorkEnd(1);

    expect(engine.runs[0].message).toContain(second.id);
    expect(engine.runs[0].message).not.toContain(first.id);
    expect(await queueOf(page.id)).toEqual([expect.objectContaining({ threadIds: [first.id], reason: "terminal" })]);
  });

  it("refuses to hand over a thread that is not waiting for the terminal session", async () => {
    seam = await startSeam2(answeringEngine());
    const page = await seam.createPage(PAGE_FILES);
    const thread = await seam.pinThread(page.id, "home.html", "Agent thread");
    await seam.waitForWorkEnd(1);

    expect((await seam.server.post(`/api/threads/${thread.id}/hand-over`, {})).status).toBe(409);
    expect((await seam.server.post(`/api/threads/nope/hand-over`, {})).status).toBe(404);
  });

  it("releases the page for a person: waiting threads go to the agent, the hold ends and new comments go to the agent until the next terminal publish", async () => {
    const engine = answeringEngine();
    seam = await startSeam2(engine);
    const page = await seam.createPage(PAGE_FILES);
    const terminal = await open("MacBook-Pro");
    await terminal.publish(page.id, "First");
    const waiting = await seam.pinThread(page.id, "home.html", "Waiting");
    await until(async () => (await queueOf(page.id)).length === 1, "the thread to wait");

    const res = await seam.server.post(`/api/pages/${page.id}/terminal-release`, {});
    expect(res.status).toBe(204);
    await seam.waitForWorkEnd(1);

    expect(engine.runs[0].message).toContain(waiting.id);
    expect(await holder(page.id)).toBeNull();
    await seam.pinThread(page.id, "home.html", "New one");
    await seam.waitForWorkEnd(2);
    expect(engine.runs).toHaveLength(2);

    await terminal.publish(page.id, "Again");
    expect(await holder(page.id)).toMatchObject({ folder: "/work/MacBook-Pro" });
    await seam.pinThread(page.id, "home.html", "Held again");
    await until(async () => (await queueOf(page.id)).length === 1, "the new thread to wait");
    expect(engine.runs).toHaveLength(2);
  });

  it("lets the terminal session release one page with release_page, and says what it handed over", async () => {
    const engine = answeringEngine();
    seam = await startSeam2(engine);
    const page = await seam.createPage(PAGE_FILES, "Accueil");
    const other = await seam.createPage(PAGE_FILES, "Inscription");
    const terminal = await open("MacBook-Pro");
    await terminal.publish(page.id, "First");
    await terminal.publish(other.id, "Second");
    await seam.pinThread(page.id, "home.html", "One");
    await seam.pinThread(page.id, "home.html", "Two");
    await seam.pinThread(other.id, "home.html", "Three");
    await until(async () => (await queueOf(page.id)).length === 2 && (await queueOf(other.id)).length === 1, "the threads to wait");

    const answer = await terminal.call("release_page", { pageId: page.id });

    expect(answer).toMatch(/Accueil/);
    expect(answer).toMatch(/2 comments handed over/);
    expect(answer).not.toMatch(/- Inscription/);
    await seam.waitForWorkEnd(2);
    expect(engine.runs).toHaveLength(2);
    expect(await holder(page.id)).toBeNull();
    expect(await holder(other.id)).toMatchObject({ folder: "/work/MacBook-Pro" });
    expect(await queueOf(other.id)).toEqual([expect.objectContaining({ reason: "terminal" })]);
  });

  it("releases every page of the session when release_page has no argument", async () => {
    const engine = answeringEngine();
    seam = await startSeam2(engine);
    const page = await seam.createPage(PAGE_FILES, "Accueil");
    const other = await seam.createPage(PAGE_FILES, "Inscription");
    const terminal = await open("MacBook-Pro");
    await terminal.publish(page.id, "First");
    await terminal.publish(other.id, "Second");
    await seam.pinThread(page.id, "home.html", "One");
    await seam.pinThread(other.id, "home.html", "Three");
    await until(async () => (await queueOf(page.id)).length === 1 && (await queueOf(other.id)).length === 1, "the threads to wait");

    const answer = await terminal.call("release_page", {});

    expect(answer).toMatch(/Accueil/);
    expect(answer).toMatch(/Inscription/);
    await seam.waitForWorkEnd(2);
    expect(await holder(page.id)).toBeNull();
    expect(await holder(other.id)).toBeNull();
  });

  it("says so when release_page has nothing to release", async () => {
    seam = await startSeam2(answeringEngine());
    const page = await seam.createPage(PAGE_FILES);
    const terminal = await open("MacBook-Pro");

    expect(await terminal.call("release_page", {})).toMatch(/holds no page/);
    expect(await terminal.call("release_page", { pageId: page.id })).toMatch(/does not hold/);
  });
});
