import { afterEach, describe, expect, it } from "vitest";
import type { QueueEntry, SessionRow, Thread } from "@redline/shared";
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

const open = (machine: string, options: { heartbeatMs?: number } = {}) => openTerminal(seam!, stops, machine, options);

async function until(condition: () => boolean | Promise<boolean>, what: string): Promise<void> {
  const deadline = Date.now() + 5_000;
  while (!(await condition())) {
    if (Date.now() > deadline) throw new Error(`Timed out waiting for ${what}`);
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
}

const queueOf = async (pageId: string) => (await (await seam!.server.get(`/api/pages/${pageId}/queue`)).json()) as QueueEntry[];
const threadOf = async (pageId: string, id: string) => ((await (await seam!.server.get(`/api/pages/${pageId}/threads`)).json()) as Thread[]).find((t) => t.id === id)!;
const rowOf = async (id: string) => ((await (await seam!.server.get("/api/sessions")).json()) as SessionRow[]).find((r) => r.id === id)!;
const heldComment = async (pageId: string, body: string) =>
  (await (await seam!.server.post(`/api/pages/${pageId}/threads`, { artboard: "home.html", selector: "h1", xPct: 5, yPct: 5, body, held: true })).json()) as Thread;

const answeringEngine = () =>
  new FakeEngine((run) => [
    ...[...run.message.matchAll(/thread id: ([0-9a-f-]{36})\)/g)].map((m) => ({ replyInThread: { threadId: m[1], text: "Agent answer" } })),
    { type: "result" as const, summary: "Agent run" },
  ]);

/** A held page with one waiting thread. */
async function waitingThread(engine = answeringEngine(), options: { terminalPresenceTimeoutMs?: number } = {}) {
  seam = await startSeam2(engine, options);
  const page = await seam.createPage(PAGE_FILES, "Accueil");
  const terminal = await open("MacBook-Pro", options.terminalPresenceTimeoutMs ? { heartbeatMs: 60_000 } : {});
  await terminal.publish(page.id, "First");
  const thread = await seam.pinThread(page.id, "home.html", "Make it blue");
  await until(async () => (await queueOf(page.id)).length === 1, "the thread to wait");
  return { engine, page, terminal, thread };
}

describe("the terminal session handles its comments", () => {
  it("says so when nothing waits", async () => {
    seam = await startSeam2(answeringEngine());
    const terminal = await open("MacBook-Pro");
    expect(await terminal.call("pending_comments", {})).toMatch(/No comment is waiting/);
  });

  it("gives the waiting threads in the agent message form with the page addresses, and marks them picked", async () => {
    const { engine, page, terminal, thread } = await waitingThread();

    const answer = await terminal.call("pending_comments", {});

    expect(answer).toContain(`thread id: ${thread.id}`);
    expect(answer).toContain("Make it blue");
    expect(answer).toContain("Page: ");
    expect(answer).toContain(page.id);
    expect(answer).toContain("home.html");
    expect(await queueOf(page.id)).toEqual([]);
    expect(await rowOf(thread.id)).toMatchObject({ status: "running", terminal: true });
    expect(engine.runs).toHaveLength(0);
    expect(await terminal.call("pending_comments", {})).toMatch(/No comment is waiting/);
  });

  it("gives the threads of a batch together and answers each one on its own", async () => {
    seam = await startSeam2(answeringEngine());
    const page = await seam.createPage(PAGE_FILES, "Accueil");
    const terminal = await open("MacBook-Pro");
    await terminal.publish(page.id, "First");
    const one = await heldComment(page.id, "One");
    const two = await heldComment(page.id, "Two");
    await seam.server.post(`/api/pages/${page.id}/send-held`, {});
    await until(async () => (await queueOf(page.id)).length === 1, "the batch to wait");

    const answer = await terminal.call("pending_comments", {});
    expect(answer).toContain(`thread id: ${one.id}`);
    expect(answer).toContain(`thread id: ${two.id}`);
    await terminal.call("reply_in_thread", { threadId: one.id, text: "Done one" });

    expect(await rowOf(one.id)).toMatchObject({ status: "answered", terminal: true });
    expect(await rowOf(two.id)).toMatchObject({ status: "running" });
  });

  it("posts the answer of a picked thread, marks it answered and shows it as the terminal session's", async () => {
    const { page, terminal, thread } = await waitingThread();
    await terminal.call("pending_comments", {});

    expect(await terminal.call("reply_in_thread", { threadId: thread.id, text: "Done, in blue" })).toContain("Reply posted");

    expect((await threadOf(page.id, thread.id)).replies.map((r) => r.body)).toEqual(["Done, in blue"]);
    expect(await rowOf(thread.id)).toMatchObject({ status: "answered", terminal: true });
    expect(await rowOf(thread.id)).not.toHaveProperty("sessionId");
  });

  it("refuses a reply in a thread an agent owns", async () => {
    seam = await startSeam2(answeringEngine());
    const page = await seam.createPage(PAGE_FILES, "Accueil");
    const agentThread = await seam.pinThread(page.id, "home.html", "Agent thread");
    await seam.waitForWorkEnd(1);
    const terminal = await open("MacBook-Pro");

    const answer = await terminal.call("reply_in_thread", { threadId: agentThread.id, text: "Not mine" });

    expect(answer).toMatch(/not given to this session/);
    expect((await threadOf(page.id, agentThread.id)).replies.map((r) => r.body)).toEqual(["Agent answer"]);
  });

  it("refuses a reply in a thread that waits but was not picked yet", async () => {
    const { page, terminal, thread } = await waitingThread();

    expect(await terminal.call("reply_in_thread", { threadId: thread.id, text: "Too early" })).toMatch(/not given to this session/);

    expect((await threadOf(page.id, thread.id)).replies).toEqual([]);
  });

  it("refuses a reply in a thread picked by another terminal session", async () => {
    const { terminal, thread } = await waitingThread();
    await terminal.call("pending_comments", {});
    const other = await open("Mac-mini");

    expect(await other.call("reply_in_thread", { threadId: thread.id, text: "Not mine" })).toMatch(/not given to this session/);
  });

  it("keeps a reply in a terminal-owned thread waiting for that session while it is present", async () => {
    const { engine, page, terminal, thread } = await waitingThread();
    await terminal.call("pending_comments", {});
    await terminal.call("reply_in_thread", { threadId: thread.id, text: "Done" });

    await seam!.server.post(`/api/threads/${thread.id}/messages`, { body: "Bigger please" });

    await until(async () => (await queueOf(page.id)).length === 1, "the reply to wait");
    expect(await queueOf(page.id)).toEqual([expect.objectContaining({ threadIds: [thread.id], reason: "terminal" })]);
    expect(engine.runs).toHaveLength(0);
    expect(await terminal.call("pending_comments", {})).toContain("Bigger please");
    expect(await rowOf(thread.id)).toMatchObject({ status: "running" });
  });

  it("sends a reply in a terminal-owned thread to a fresh agent session once its terminal session is gone", async () => {
    const { engine, terminal, thread, page } = await waitingThread();
    await terminal.call("pending_comments", {});
    await terminal.call("reply_in_thread", { threadId: thread.id, text: "Done in blue" });
    await terminal.quit();

    await seam!.server.post(`/api/threads/${thread.id}/messages`, { body: "Bigger please" });
    // The terminal session's own answer ended one work item already.
    await seam!.waitForWorkEnd(2);

    expect(engine.runs).toHaveLength(1);
    expect(engine.runs[0].resume).toBe(false);
    expect(engine.runs[0].message).toContain("Done in blue");
    expect(engine.runs[0].message).toContain("Bigger please");
    expect((await threadOf(page.id, thread.id)).replies.map((r) => r.body)).toEqual(["Done in blue", "Bigger please", "Agent answer"]);
    expect(await rowOf(thread.id)).not.toHaveProperty("terminal");
  });

  it("sends a reply that waited for a terminal session to a fresh agent session when that session leaves", async () => {
    const { engine, terminal, thread } = await waitingThread();
    await terminal.call("pending_comments", {});
    await terminal.call("reply_in_thread", { threadId: thread.id, text: "Done in blue" });
    await seam!.server.post(`/api/threads/${thread.id}/messages`, { body: "Bigger please" });

    await terminal.quit();
    await seam!.waitForWorkEnd(2);

    expect(engine.runs[0].resume).toBe(false);
    expect(engine.runs[0].message).toContain("Done in blue");
  });

  it("gives a picked thread left unanswered to the agent when the session leaves", async () => {
    const { engine, terminal, thread, page } = await waitingThread();
    await terminal.call("pending_comments", {});

    await terminal.quit();
    await seam!.waitForWorkEnd(1);

    expect(engine.runs[0].message).toContain(thread.id);
    expect((await threadOf(page.id, thread.id)).replies.map((r) => r.body)).toEqual(["Agent answer"]);
    expect(await rowOf(thread.id)).toMatchObject({ status: "answered" });
    expect(await rowOf(thread.id)).not.toHaveProperty("terminal");
  });

  it("gives a picked thread left unanswered to the agent when the session goes quiet", async () => {
    const { engine, terminal } = await waitingThread(answeringEngine(), { terminalPresenceTimeoutMs: 600 });
    await terminal.call("pending_comments", {});

    await seam!.waitForWorkEnd(1);

    expect(engine.runs).toHaveLength(1);
  });
});
