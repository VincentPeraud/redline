import { afterEach, describe, expect, it } from "vitest";
import type { ConversationDetail, QueueEntry, SessionRow, Thread } from "@redline/shared";
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
const threadsOf = async (pageId: string) => (await (await seam!.server.get(`/api/pages/${pageId}/threads`)).json()) as Thread[];
const heldComment = async (pageId: string, body: string) =>
  (await (await seam!.server.post(`/api/pages/${pageId}/threads`, { artboard: "home.html", selector: "h1", xPct: 5, yPct: 5, body, held: true })).json()) as Thread;
const sessionRows = async () => (await (await seam!.server.get("/api/sessions")).json()) as SessionRow[];

/** An agent that answers every thread of its message. */
const answeringEngine = () =>
  new FakeEngine((run) => [
    ...[...run.message.matchAll(/thread id: ([0-9a-f-]{36})\)/g)].map((m) => ({ replyInThread: { threadId: m[1], text: "Agent answer" } })),
    { type: "result" as const, summary: "Agent run" },
  ]);

describe("comments wait for the terminal session that holds the page", () => {
  it("keeps a new thread on a held page waiting, shows why, and never gives it to the agent", async () => {
    const engine = answeringEngine();
    seam = await startSeam2(engine);
    const page = await seam.createPage(PAGE_FILES);
    const terminal = await open("MacBook-Pro");
    await terminal.publish(page.id, "First");

    const thread = await seam.pinThread(page.id, "home.html", "Make it blue");

    await until(async () => (await queueOf(page.id)).length === 1, "the thread to wait");
    expect(await queueOf(page.id)).toEqual([expect.objectContaining({ threadIds: [thread.id], reason: "terminal" })]);
    expect(engine.runs).toHaveLength(0);
    const row = (await sessionRows()).find((r) => r.id === thread.id);
    expect(row).toMatchObject({ status: "queued", waitingReason: "terminal" });
  });

  it("does not hold comments of a page nobody holds", async () => {
    const engine = answeringEngine();
    seam = await startSeam2(engine);
    const page = await seam.createPage(PAGE_FILES);
    await open("MacBook-Pro");

    await seam.pinThread(page.id, "home.html", "Make it blue");
    await seam.waitForWorkEnd(1);

    expect(engine.runs).toHaveLength(1);
  });

  it("keeps held comments sent together waiting as one batch", async () => {
    const engine = answeringEngine();
    seam = await startSeam2(engine);
    const page = await seam.createPage(PAGE_FILES);
    const terminal = await open("MacBook-Pro");
    await terminal.publish(page.id, "First");
    const first = await heldComment(page.id, "One");
    const second = await heldComment(page.id, "Two");

    await seam.server.post(`/api/pages/${page.id}/send-held`, {});

    await until(async () => (await queueOf(page.id)).length === 1, "the batch to wait");
    expect(await queueOf(page.id)).toEqual([expect.objectContaining({ threadIds: [first.id, second.id], reason: "terminal" })]);
    expect(engine.runs).toHaveLength(0);
  });

  it("sends a reply in a thread an agent started to that agent, although the page is now held", async () => {
    const engine = answeringEngine();
    seam = await startSeam2(engine);
    const page = await seam.createPage(PAGE_FILES);
    const thread = await seam.pinThread(page.id, "home.html", "Agent thread");
    await seam.waitForWorkEnd(1);
    const terminal = await open("MacBook-Pro");
    await terminal.publish(page.id, "First");

    await seam.server.post(`/api/threads/${thread.id}/messages`, { body: "More please" });
    await seam.waitForWorkEnd(2);

    expect(engine.runs.map((r) => r.resume)).toEqual([false, true]);
    expect(await queueOf(page.id)).toEqual([]);
  });

  it("never holds a conversation", async () => {
    const engine = answeringEngine();
    seam = await startSeam2(engine);
    const page = await seam.createPage(PAGE_FILES);
    const terminal = await open("MacBook-Pro");
    await terminal.publish(page.id, "First");
    const conversation = (await (await seam.server.post(`/api/pages/${page.id}/conversations`, {})).json()) as ConversationDetail;

    await seam.server.post(`/api/conversations/${conversation.id}/messages`, { body: "Let's talk" });
    await seam.waitForWorkEnd(1);

    expect(engine.runs[0].message).toContain("Let's talk");
  });

  it("ends every terminal tool answer with the waiting comments per page", async () => {
    seam = await startSeam2(answeringEngine());
    const page = await seam.createPage(PAGE_FILES, "Accueil");
    const other = await seam.createPage(PAGE_FILES, "Inscription");
    const terminal = await open("MacBook-Pro");
    expect(await terminal.publish(page.id, "First")).not.toContain("en attente");
    await terminal.publish(other.id, "Second");
    await seam.pinThread(page.id, "home.html", "One");
    await seam.pinThread(page.id, "home.html", "Two");
    await seam.pinThread(other.id, "home.html", "Three");
    await until(async () => (await queueOf(page.id)).length === 2, "the threads to wait");

    const answer = await terminal.call("list_projects", {});

    expect(answer).toMatch(/2 commentaires en attente sur Accueil, 1 sur Inscription : appelle pending_comments si la personne le demande/);
  });

  it("gives the waiting threads to the agent when the terminal session says bye", async () => {
    const engine = answeringEngine();
    seam = await startSeam2(engine);
    const page = await seam.createPage(PAGE_FILES);
    const terminal = await open("MacBook-Pro");
    await terminal.publish(page.id, "First");
    const thread = await seam.pinThread(page.id, "home.html", "Make it blue");
    await until(async () => (await queueOf(page.id)).length === 1, "the thread to wait");

    await terminal.quit();
    await seam.waitForWorkEnd(1);

    expect(engine.runs[0].message).toContain(thread.id);
    expect((await threadsOf(page.id))[0].replies.map((r) => r.body)).toEqual(["Agent answer"]);
    expect(await queueOf(page.id)).toEqual([]);
  });

  it("gives the waiting threads to the agent when the terminal session goes quiet", async () => {
    const engine = answeringEngine();
    seam = await startSeam2(engine, { terminalPresenceTimeoutMs: 400 });
    const page = await seam.createPage(PAGE_FILES);
    const terminal = await open("MacBook-Pro", { heartbeatMs: 60_000 });
    await terminal.publish(page.id, "First");
    await seam.pinThread(page.id, "home.html", "Make it blue");
    await until(async () => (await queueOf(page.id)).length === 1, "the thread to wait");
    expect(engine.runs).toHaveLength(0);

    await seam.waitForWorkEnd(1);

    expect(engine.runs).toHaveLength(1);
  });

  it("keeps waiting threads waiting for one timeout window after a server restart, then routes them to the agent", async () => {
    const engine = answeringEngine();
    seam = await startSeam2(engine, { terminalPresenceTimeoutMs: 1_200 });
    const page = await seam.createPage(PAGE_FILES);
    const terminal = await open("MacBook-Pro", { heartbeatMs: 60_000 });
    await terminal.publish(page.id, "First");
    await seam.pinThread(page.id, "home.html", "Make it blue");
    await until(async () => (await queueOf(page.id)).length === 1, "the thread to wait");

    await seam.restartServer({ downForMs: 50 });

    expect(await queueOf(page.id)).toEqual([expect.objectContaining({ reason: "terminal" })]);
    expect(engine.runs).toHaveLength(0);
    // The restarted server routes it like any work: the agent is still reconnecting, so it waits for the agent.
    await until(async () => (await queueOf(page.id))[0]?.reason !== "terminal", "the thread to leave the terminal's list");
  });
});
